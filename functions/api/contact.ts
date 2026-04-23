// POST /api/contact — placeholder contact handler.
// Until we wire up an outbound mailer (Resend, Postmark, or similar),
// this just validates and succeeds. Joe: we'll replace this with a real
// email-forward once you pick a transactional sender.

export const onRequestPost: PagesFunction = async ({ request }) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  let data: { name?: string; email?: string; message?: string } = {};
  try {
    data = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  const { name, email, message } = data;
  if (!name || !email || !message) {
    return json({ error: "Missing fields" }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Invalid email" }, 400);
  }

  // TODO: forward to joe@vibinpsybin.band via a transactional sender.
  // For now, accept and move on.
  console.log("contact form submission", { name, email, len: message.length });
  return json({ ok: true });
};
