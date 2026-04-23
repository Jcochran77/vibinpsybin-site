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
      // Probably already subscribed — Buttondown returns 400 for dupes
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const detail = body && typeof body === "object" ? JSON.stringify(body) : "";
      if (detail.includes("already") || detail.includes("exist")) {
        return json({ ok: true, note: "already subscribed" });
      }
      return json({ error: "Could not subscribe. Is that email valid?" }, 400);
    }
    return json({ error: "Subscribe failed. Try again later." }, 502);
  } catch (e) {
    return json({ error: "Network error. Try again." }, 502);
  }
};
