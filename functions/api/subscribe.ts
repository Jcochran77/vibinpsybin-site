// POST /api/subscribe — adds an email to the Resend Audience and sends a
// welcome email so the subscriber actually knows it worked.
//
// DESIGN PRINCIPLE (Joe, 2026-05-18): No third party gets to decide who's
// "spammy" enough to be a fan of Joe's band. We own the list. Resend is
// just a delivery tool — when we send release blasts, we read this audience
// and send. If we ever leave Resend, we export the audience as a CSV and
// import wherever next.
//
// Flow:
//   1. Validate the email.
//   2. Add to Resend Audience. Duplicates are idempotent — Resend treats
//      them as success.
//   3. Send a welcome email via the Resend Emails API. Best-effort: if it
//      fails, the user is still subscribed and we log it.
//   4. If the audience add itself fails, fall back to emailing Joe so the
//      address isn't lost.
//   5. Always return 200 OK to the user. The user is not a debugging widget.
//
// Required env: RESEND_API_KEY, RESEND_AUDIENCE_ID
// Optional env: RESEND_FROM_ADDRESS (verified domain sender),
//               RESEND_TO_ADDRESS (Joe's address for fallbacks)

interface Env {
  RESEND_API_KEY: string;
  RESEND_AUDIENCE_ID: string;
  RESEND_FROM_ADDRESS?: string;
  RESEND_TO_ADDRESS?: string;
}

// Until vibinpsybin.band is verified in Resend, use the shared sender.
// Once verified, set RESEND_FROM_ADDRESS=hello@vibinpsybin.band (or similar)
// in Cloudflare Pages env to use the band's domain for both deliverability
// and reply-handling.
const DEFAULT_FROM = "Vibin' Psybin <onboarding@resend.dev>";
const DEFAULT_TO = "vibinpsybin@gmail.com";
const RESEND_TIMEOUT_MS = 8_000;

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  // --- 1. Parse + validate ---
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
    await emailJoeFallback(env, email, "RESEND_AUDIENCE_ID missing").catch(
      () => {},
    );
    return json({ ok: true });
  }

  // --- 2. Add to Resend Audience ---
  // We track whether this contact is *new* in the audience so we only send
  // the welcome email once. Resend returns 201 for "created" and 200 for
  // "already exists" — we treat both as success but only send welcome on
  // 201. (Resend's API actually responds 200 in both cases on the
  // audiences/contacts endpoint; we de-dupe with a HEAD-style check.)
  const audienceResult = await addToResendAudience(
    email,
    env.RESEND_API_KEY,
    env.RESEND_AUDIENCE_ID,
  );

  if (audienceResult.kind === "error") {
    console.warn(`[subscribe] Resend audience add failed; falling back`, {
      email,
      detail: audienceResult.detail,
    });
    const fallbackTask = emailJoeFallback(env, email, audienceResult.detail).catch(
      (e) => {
        console.error("[subscribe] fallback email also failed", {
          email,
          emailError: e instanceof Error ? e.message : String(e),
        });
      },
    );
    if (waitUntil) {
      waitUntil(fallbackTask);
    } else {
      await fallbackTask;
    }
    return json({ ok: true });
  }

  // --- 3. Send welcome email (best-effort, don't block the user) ---
  // Use waitUntil so the email send completes even after we've returned the
  // response to the user. Without it, Pages Functions kill the in-flight
  // fetch as soon as the response is sent and the welcome never delivers.
  if (audienceResult.isNew) {
    const sendTask = sendWelcomeEmail(env, email).catch((e) => {
      console.error("[subscribe] welcome email send failed", {
        email,
        error: e instanceof Error ? e.message : String(e),
      });
    });
    if (waitUntil) {
      waitUntil(sendTask);
    } else {
      // Synchronously await as a fallback (older runtimes); slows the user
      // response by ~150-400ms but guarantees the email goes out.
      await sendTask;
    }
  } else {
    console.log("[subscribe] existing contact, skipping welcome email", {
      email,
    });
  }

  return json({ ok: true });
};

// ---- Resend audience add ----

type AudienceResult =
  | { kind: "success"; isNew: boolean }
  | { kind: "error"; detail: string };

async function addToResendAudience(
  email: string,
  apiKey: string,
  audienceId: string,
): Promise<AudienceResult> {
  // The audience-add endpoint returns success for both new and existing
  // contacts without telling us which it was. To know whether to send a
  // welcome email, we first list contacts and check. Cheaper than triggering
  // a duplicate welcome on every page refresh + form re-submit.
  let alreadyExists = false;
  try {
    const listRes = await fetch(
      `https://api.resend.com/audiences/${audienceId}/contacts`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        // We pull all contacts; audience is small enough that this is fine
        // for the foreseeable future. If we cross a few thousand contacts
        // we should swap to a per-email lookup or maintain a cache.
      },
    );
    if (listRes.ok) {
      const body = (await listRes.json().catch(() => null)) as {
        data?: { email: string }[];
      } | null;
      const contacts = body?.data ?? [];
      alreadyExists = contacts.some((c) => c.email.toLowerCase() === email);
    }
    // If listing fails we just assume "new" — worst case is a duplicate
    // welcome email, which is way better than no welcome email at all.
  } catch {
    // same — treat as new
  }

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
      return { kind: "success", isNew: !alreadyExists };
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

// ---- Welcome email ----

async function sendWelcomeEmail(env: Env, email: string): Promise<void> {
  const from = env.RESEND_FROM_ADDRESS || DEFAULT_FROM;
  const subject = "🎸 You're on the list — Vibin' Psybin";

  const text = [
    `Hey,`,
    ``,
    `You signed up for Vibin' Psybin and the Sunlight Band's email list.`,
    `Thanks. Means a lot.`,
    ``,
    `Here's the deal: I'll email you when there's something worth telling`,
    `you. New music. New video. A show in your town. New merch. Probably`,
    `more often than you'd think — I make a lot of music — but never daily,`,
    `never noisy, never just to be in your inbox.`,
    ``,
    `If that ever stops being worth it, the unsubscribe link is at the`,
    `bottom of every email and I won't take it personally.`,
    ``,
    `Until then — listen loud.`,
    ``,
    `— Joe`,
    `   Vibin' Psybin and the Sunlight Band`,
    `   https://vibinpsybin.band`,
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #1c1c1c; line-height: 1.55;">
    <p>Hey,</p>
    <p>You signed up for <strong>Vibin&rsquo; Psybin and the Sunlight Band</strong>&rsquo;s email list. Thanks. Means a lot.</p>
    <p>Here&rsquo;s the deal: I&rsquo;ll email you when there&rsquo;s something worth telling you. New music. New video. A show in your town. New merch. Probably more often than you&rsquo;d think &mdash; I make a lot of music &mdash; but never daily, never noisy, never just to be in your inbox.</p>
    <p>If that ever stops being worth it, the unsubscribe link is at the bottom of every email and I won&rsquo;t take it personally.</p>
    <p>Until then &mdash; listen loud.</p>
    <p style="margin-top: 28px;">
      &mdash; Joe<br>
      <span style="color: #666;">Vibin&rsquo; Psybin and the Sunlight Band</span><br>
      <a href="https://vibinpsybin.band" style="color: #b8860b;">vibinpsybin.band</a>
    </p>
  </body>
</html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject,
      text,
      html,
      // Replies should land in Joe's inbox so fans can write back.
      reply_to: env.RESEND_TO_ADDRESS || DEFAULT_TO,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend welcome ${res.status}: ${detail.slice(0, 200)}`);
  }
  console.log("[subscribe] welcome email sent", { email });
}

// ---- Fallback: email Joe if audience add fails ----

async function emailJoeFallback(
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
