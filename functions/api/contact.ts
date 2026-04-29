// POST /api/contact — Say Hey form delivery.
//
// Primary: Resend → vibinpsybin@gmail.com (Reply-To = submitter).
// Secondary: best-effort Telegram ping to the Music group.
//
// Required env: RESEND_API_KEY
// Optional env: RESEND_FROM_ADDRESS, RESEND_TO_ADDRESS,
//               TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//
// All env is read via the Pages function `env` binding (NOT process.env).

interface Env {
  RESEND_API_KEY: string;
  RESEND_FROM_ADDRESS?: string;
  RESEND_TO_ADDRESS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

const DEFAULT_FROM = "Vibin' Psybin <onboarding@resend.dev>";
const DEFAULT_TO = "vibinpsybin@gmail.com";
const DEFAULT_TG_CHAT = "-5203788960";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  let data: { name?: string; email?: string; message?: string; kind?: string } = {};
  try {
    data = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  const name = (data.name || "").trim();
  const email = (data.email || "").trim();
  const message = (data.message || "").trim();
  const kind = (data.kind || "").trim();

  if (!name || !email || !message) {
    return json({ error: "Missing fields" }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Invalid email" }, 400);
  }

  if (!env.RESEND_API_KEY) {
    console.error("contact: RESEND_API_KEY not configured");
    return json({ error: "Server not configured" }, 500);
  }

  const from = env.RESEND_FROM_ADDRESS || DEFAULT_FROM;
  const to = env.RESEND_TO_ADDRESS || DEFAULT_TO;
  const sourceUrl = request.headers.get("referer") || "https://vibinpsybin.band/contact";
  const timestamp = new Date().toISOString();

  const subject = kind && kind !== "hello"
    ? `Say Hey: ${kind} — from ${name}`
    : `Say Hey from ${name}`;

  const textBody = [
    `New "Say Hey" message from the Vibin' Psybin site.`,
    ``,
    `Name:    ${name}`,
    `Email:   ${email}`,
    kind ? `Kind:    ${kind}` : null,
    `Source:  ${sourceUrl}`,
    `When:    ${timestamp}`,
    ``,
    `--- Message ---`,
    message,
    ``,
    `(Reply directly to this email — it'll go straight to ${name}.)`,
  ].filter(Boolean).join("\n");

  // --- Primary: Resend ---
  let resendId: string | undefined;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject,
        text: textBody,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("contact: resend failed", { status: res.status, detail });
      return json({ error: "Could not send. Please email us directly at vibinpsybin@gmail.com." }, 500);
    }
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    resendId = body?.id;
  } catch (e) {
    console.error("contact: resend network error", e);
    return json({ error: "Network error sending message. Try again later." }, 500);
  }

  console.log("contact form submission", {
    name,
    email,
    kind: kind || null,
    len: message.length,
    resendId: resendId || null,
  });

  // --- Secondary: Telegram (best-effort) ---
  if (env.TELEGRAM_BOT_TOKEN) {
    const chatId = env.TELEGRAM_CHAT_ID || DEFAULT_TG_CHAT;
    const truncated = message.length > 200 ? message.slice(0, 200) + "…" : message;
    const tgText =
      `🎤 New "Say Hey" from ${name} (${email})\n` +
      (kind ? `Kind: ${kind}\n` : "") +
      `Message: ${truncated}`;
    try {
      const tgRes = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: tgText, disable_web_page_preview: true }),
        },
      );
      if (!tgRes.ok) {
        const tgDetail = await tgRes.text().catch(() => "");
        console.error("contact: telegram ping failed", { status: tgRes.status, detail: tgDetail });
      }
    } catch (e) {
      console.error("contact: telegram ping error", e);
    }
  } else {
    console.log("contact: TELEGRAM_BOT_TOKEN not set; skipping telegram ping");
  }

  return json({ ok: true });
};
