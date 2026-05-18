// POST /api/subscribe — adds an email to the Resend Audience.
//
// DESIGN PRINCIPLE (Joe, 2026-05-18): No third party gets to decide who's
// "spammy" enough to be a fan of Joe's band. We own the list. Resend is
// just a delivery tool — when we send the next release blast, we read this
// audience and send. If we ever leave Resend, we export the audience as a
// CSV and import wherever next.
//
// We previously used Buttondown. Buttondown's "Firewall" feature rejected
// legitimate fans with `subscriber_blocked`, and then their API had a
// multi-hour outage that broke every signup. Two failures in a row, both
// costing us subscribers we'll never get back. Resend Audiences has no
// such firewall and is the same product we already use for the contact
// form — one vendor, one bill, one failure surface.
//
// Layers (in order):
//   1. Add to Resend Audience  →  return 200 OK.
//   2. If the contacts API call fails for any reason, fall back to emailing
//      Joe via the Resend Emails API (different endpoint, same vendor) with
//      the address. He adds it manually from his inbox.
//   3. Both Resend endpoints down  →  log loud, still return 200 OK. The
//      user is not a debugging widget for our backend stack.
//
// Required env: RESEND_API_KEY, RESEND_AUDIENCE_ID
// Optional env: RESEND_FROM_ADDRESS, RESEND_TO_ADDRESS (fallback notification)

interface Env {
  RESEND_API_KEY: string;
  RESEND_AUDIENCE_ID: string;
  RESEND_FROM_ADDRESS?: string;
  RESEND_TO_ADDRESS?: string;
}

const DEFAULT_FROM = "Vibin' Psybin <onboarding@resend.dev>";
const DEFAULT_TO = "vibinpsybin@gmail.com";
const RESEND_TIMEOUT_MS = 8_000;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

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

  if (!env.RESEND_API_KEY) {
    console.error("[subscribe] RESEND_API_KEY not configured");
    return json({ ok: true });
  }
  if (!env.RESEND_AUDIENCE_ID) {
    console.error("[subscribe] RESEND_AUDIENCE_ID not configured");
    // Best-effort: at least email Joe so the address isn't lost.
    await emailFallback(env, email, "RESEND_AUDIENCE_ID missing").catch(() => {});
    return json({ ok: true });
  }

  // --- 2. Add to Resend Audience ---
  const audienceResult = await addToResendAudience(
    email,
    env.RESEND_API_KEY,
    env.RESEND_AUDIENCE_ID,
  );

  if (audienceResult.kind === "success") {
    // Done. Resend treats duplicates as success, so this is also the
    // "already subscribed" path.
    return json({ ok: true });
  }

  // --- 3. Fallback: email Joe with the address ---
  console.warn(`[subscribe] Resend audience add failed; falling back`, {
    email,
    detail: audienceResult.detail,
  });
  await emailFallback(env, email, audienceResult.detail).catch((e) => {
    console.error("[subscribe] fallback email also failed", {
      email,
      audienceError: audienceResult.detail,
      emailError: e instanceof Error ? e.message : String(e),
    });
  });

  return json({ ok: true });
};

// ---- Resend audience add ----

type AudienceResult =
  | { kind: "success" }
  | { kind: "error"; detail: string };

async function addToResendAudience(
  email: string,
  apiKey: string,
  audienceId: string,
): Promise<AudienceResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.resend.com/audiences/${audienceId}/contacts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, unsubscribed: false }),
        signal: controller.signal,
      },
    );
    if (res.ok) {
      return { kind: "success" };
    }
    const detail = await res.text().catch(() => "");
    return {
      kind: "error",
      detail: `${res.status}: ${detail.slice(0, 300) || "(no body)"}`,
    };
  } catch (e) {
    return {
      kind: "error",
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---- Fallback: email Joe if audience add fails ----

async function emailFallback(
  env: Env,
  email: string,
  reason: string,
): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  const from = env.RESEND_FROM_ADDRESS || DEFAULT_FROM;
  const to = env.RESEND_TO_ADDRESS || DEFAULT_TO;

  const subject = `🎸 Subscriber needs manual add: ${email}`;
  const text = [
    `Resend Audience add failed at vibinpsybin.band/api/subscribe.`,
    ``,
    `Email: ${email}`,
    `Reason: ${reason}`,
    ``,
    `Add manually:`,
    `1. Open Resend → Audiences → vibinpsybin-site fans`,
    `2. Add contact: ${email}`,
    ``,
    `The user saw "Welcome aboard" and walked away happy.`,
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
    throw new Error(`Resend email ${res.status}: ${detail.slice(0, 200)}`);
  }
}
