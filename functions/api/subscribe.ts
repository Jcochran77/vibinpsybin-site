// POST /api/subscribe — adds an email to the Buttondown list.
//
// DESIGN PRINCIPLE (Joe, 2026-05-18): NO LEGITIMATE FAN SHOULD EVER FAIL TO
// SIGN UP. The user clicks submit, they're on the list. Period. If Buttondown
// firewalls the address, or their API is down, or anything else goes wrong,
// we still capture the email to a fallback channel and return success to the
// user. Joe (or Cortana) reconciles to Buttondown later.
//
// Failure-capture layers (in order of preference):
//   1. Buttondown success → done.
//   2. Buttondown 4xx "already subscribed" → idempotent success, done.
//   3. Buttondown firewall block (subscriber_blocked) → email Joe via Resend,
//      tagged so we know to add manually. User sees success.
//   4. Buttondown 5xx / network / API timeout → email Joe via Resend with the
//      raw address + the error. User sees success.
//   5. Even Resend fails → log loud, return success anyway. The user is not
//      a debugging widget for our backend stack.
//
// We NEVER show the user a "you got filtered" or "email us manually" message.
// The signup UX should be exactly as easy as one click + one email field.
//
// Required env: BUTTONDOWN_API_KEY
// Recommended env: RESEND_API_KEY, RESEND_TO_ADDRESS (fallback capture path)

interface Env {
  BUTTONDOWN_API_KEY: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  RESEND_TO_ADDRESS?: string;
}

const DEFAULT_RESEND_FROM = "Vibin' Psybin <onboarding@resend.dev>";
const DEFAULT_RESEND_TO = "vibinpsybin@gmail.com";
const BUTTONDOWN_TIMEOUT_MS = 8_000;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (!env.BUTTONDOWN_API_KEY) {
    console.error("[subscribe] BUTTONDOWN_API_KEY not configured");
    // Even with no Buttondown configured, if we have Resend we can still capture.
    // But if neither is configured we have nowhere to put this — fail soft anyway.
    return json({ ok: true });
  }

  // --- 1. Parse + validate the email ---
  let data: { email?: string } = {};
  try {
    data = await request.json();
  } catch {
    return json({ error: "Please enter a valid email address." }, 400);
  }
  const email = (data.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Please enter a valid email address." }, 400);
  }

  // --- 2. Try Buttondown ---
  const buttondownResult = await tryButtondown(email, env.BUTTONDOWN_API_KEY);

  if (buttondownResult.kind === "success") {
    return json({ ok: true });
  }

  // --- 3. Fallback: capture via Resend so the address is never lost ---
  console.warn(
    `[subscribe] Buttondown ${buttondownResult.kind}; capturing via fallback`,
    { email, detail: buttondownResult.detail },
  );

  // Best-effort capture. If this also fails, log loud and still tell the user
  // they're good. The address ends up in Cloudflare Pages function logs as a
  // last-resort transcript; we'd rather you reconcile a few addresses by hand
  // than fail a real fan at the form.
  await captureFallback(env, email, buttondownResult).catch((e) => {
    console.error("[subscribe] fallback capture failed completely", {
      email,
      error: e instanceof Error ? e.message : String(e),
    });
  });

  return json({ ok: true });
};

// ---- Buttondown attempt ----

type ButtondownResult =
  | { kind: "success" }
  | { kind: "blocked"; detail: string }
  | { kind: "api_error"; detail: string }
  | { kind: "network_error"; detail: string };

async function tryButtondown(
  email: string,
  apiKey: string,
): Promise<ButtondownResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BUTTONDOWN_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.buttondown.email/v1/subscribers", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email_address: email,
        tags: ["vibinpsybin-site"],
      }),
      signal: controller.signal,
    });

    if (res.status === 201 || res.status === 200) {
      return { kind: "success" };
    }
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as
        | { code?: string; detail?: string }
        | null;
      const code = body?.code || "";
      const detail = body?.detail || "";

      // "Already subscribed" is idempotent success from our point of view.
      if (
        code === "subscriber_already_exists" ||
        code.includes("already") ||
        detail.toLowerCase().includes("already")
      ) {
        return { kind: "success" };
      }

      // Firewall / spam block. Capture via fallback so we don't lose the lead.
      if (
        code === "subscriber_blocked" ||
        code === "firewall" ||
        detail.toLowerCase().includes("firewall") ||
        detail.toLowerCase().includes("blocked")
      ) {
        return { kind: "blocked", detail: detail || code || "blocked" };
      }

      // Any other 400 — treat as "we couldn't make sense of it"; still capture.
      return { kind: "api_error", detail: `400: ${code || detail || "bad request"}` };
    }

    // 5xx / 429 / anything else — Buttondown is unhappy. Capture.
    const detail = await res.text().catch(() => "");
    return {
      kind: "api_error",
      detail: `${res.status}: ${detail.slice(0, 200) || "(no body)"}`,
    };
  } catch (e) {
    // Network error, DNS, timeout, or abort.
    return {
      kind: "network_error",
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---- Fallback capture: email Joe via Resend ----

async function captureFallback(
  env: Env,
  email: string,
  reason: Exclude<ButtondownResult, { kind: "success" }>,
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.error("[subscribe] RESEND_API_KEY not set; cannot capture fallback", {
      email,
      reason,
    });
    return;
  }

  const from = env.RESEND_FROM_ADDRESS || DEFAULT_RESEND_FROM;
  const to = env.RESEND_TO_ADDRESS || DEFAULT_RESEND_TO;
  const reasonLabel =
    reason.kind === "blocked"
      ? "Buttondown spam-firewall block"
      : reason.kind === "api_error"
        ? "Buttondown API returned an error"
        : "Buttondown was unreachable";

  const subject = `🎸 New subscriber needs manual add: ${email}`;
  const text = [
    `Someone tried to sign up at vibinpsybin.band and Buttondown didn't accept them automatically.`,
    ``,
    `Email: ${email}`,
    `Reason: ${reasonLabel}`,
    `Detail: ${reason.detail}`,
    ``,
    `What to do:`,
    `1. Open Buttondown → Subscribers → Add subscriber.`,
    `2. Paste the email above.`,
    `3. If Buttondown's UI also rejects it, add it to your manual-add list — they're a real fan, not a bot (we'd catch bots with Turnstile if that ever ships on /subscribe).`,
    ``,
    `The user saw "You're on the list" and walked away happy. Reconciliation is on us.`,
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      reply_to: email,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 200)}`);
  }
  console.log("[subscribe] fallback capture emailed", { email, reason: reason.kind });
}
