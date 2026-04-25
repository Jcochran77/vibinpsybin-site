// POST /api/subscribe — adds an email to the Buttondown list
// Cloudflare Pages Function

interface Env {
  BUTTONDOWN_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (!env.BUTTONDOWN_API_KEY) {
    return json({ error: "Server not configured" }, 500);
  }

  let data: { email?: string } = {};
  try {
    data = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  const email = (data.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Please enter a valid email address." }, 400);
  }

  try {
    const res = await fetch("https://api.buttondown.email/v1/subscribers", {
      method: "POST",
      headers: {
        Authorization: `Token ${env.BUTTONDOWN_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email_address: email,
        tags: ["vibinpsybin-site"],
      }),
    });

    if (res.status === 201 || res.status === 200) {
      return json({ ok: true });
    }
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as
        | { code?: string; detail?: string }
        | null;
      const code = body?.code || "";
      const detail = body?.detail || "";

      // Already subscribed — treat as success (idempotent signup)
      if (
        code.includes("already") ||
        detail.toLowerCase().includes("already") ||
        code === "subscriber_already_exists"
      ) {
        return json({ ok: true, note: "already subscribed" });
      }

      // Firewall block — Buttondown thinks the email is risky/spam.
      // Surface a clearer message so it's obvious it's not a typo.
      if (code === "subscriber_blocked" || detail.toLowerCase().includes("firewall")) {
        return json(
          {
            error:
              "Your email got flagged by our spam filter. Email us at vibinpsybin@gmail.com and we'll add you manually.",
          },
          400,
        );
      }

      // Anything else 400-ish: keep a polite generic.
      return json({ error: "Could not subscribe. Is that email valid?" }, 400);
    }
    return json({ error: "Subscribe failed. Try again later." }, 502);
  } catch (e) {
    return json({ error: "Network error. Try again." }, 502);
  }
};
