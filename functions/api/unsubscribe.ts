// /api/unsubscribe — handles unsubscribe requests from email recipients.
//
// Two entry points (both required by RFC 8058 + Gmail/Yahoo bulk rules):
//
//   GET /api/unsubscribe?email=<addr>&token=<hmac>
//     Human-readable path. Redirects to /unsubscribed (a friendly page on
//     the site) after marking the contact unsubscribed.
//
//   POST /api/unsubscribe
//     One-click path. Gmail/Yahoo/Apple Mail's "Unsubscribe" button in the
//     header sends a POST here. We process the same body params (email,
//     token) from form-urlencoded data, return 200/202 with an empty body,
//     and mark the contact unsubscribed.
//
// Security:
//   Both paths require `token = HMAC_SHA256(UNSUBSCRIBE_SECRET, email)` as
//   a hex string. Without this, anyone could unsubscribe anyone by guessing
//   addresses. The token is generated on the email-sender side (see
//   subscribe.ts) and embedded in the List-Unsubscribe header and footer
//   link of every outgoing email.
//
// Idempotent:
//   Unsubscribing an already-unsubscribed contact is a no-op success.
//   Removing a contact that was never in the audience is also a success
//   (we don't leak whether a given email was ever subscribed).

interface Env {
  RESEND_API_KEY: string;
  RESEND_AUDIENCE_ID: string;
  UNSUBSCRIBE_SECRET: string;
}

const SITE_ORIGIN = "https://vibinpsybin.band";

// ---- Shared handler logic ----

async function handleUnsubscribe(
  email: string,
  token: string,
  env: Env,
): Promise<{ ok: boolean; reason?: string }> {
  if (!email || !token) {
    return { ok: false, reason: "missing email or token" };
  }
  if (!env.UNSUBSCRIBE_SECRET || !env.RESEND_API_KEY || !env.RESEND_AUDIENCE_ID) {
    console.error("[unsubscribe] missing required env vars");
    return { ok: false, reason: "server not configured" };
  }

  const expected = await hmacSha256Hex(env.UNSUBSCRIBE_SECRET, email);
  // Constant-time compare to avoid timing oracle.
  if (!constantTimeEqual(expected, token)) {
    console.warn("[unsubscribe] bad token", { email });
    return { ok: false, reason: "invalid token" };
  }

  // Mark the contact unsubscribed in the Resend audience.
  // PATCH /audiences/{id}/contacts/{email} with unsubscribed=true.
  // The Resend API accepts the email address as the path identifier.
  const url = `https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts/${encodeURIComponent(email)}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ unsubscribed: true }),
    });
    if (res.ok) {
      console.log("[unsubscribe] success", { email });
      return { ok: true };
    }
    // 404 = contact never existed. Treat as success — we don't leak audience
    // membership, and the user clearly wants to NOT receive email from us.
    if (res.status === 404) {
      console.log("[unsubscribe] contact not found, treating as success", { email });
      return { ok: true };
    }
    const detail = await res.text().catch(() => "");
    console.error("[unsubscribe] Resend PATCH failed", {
      email,
      status: res.status,
      detail: detail.slice(0, 300),
    });
    return { ok: false, reason: `Resend ${res.status}` };
  } catch (e) {
    console.error("[unsubscribe] Resend PATCH threw", {
      email,
      error: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, reason: "network error" };
  }
}

// ---- HMAC helpers ----

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---- GET handler (human click from email footer) ----

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const token = (url.searchParams.get("token") || "").trim();

  const result = await handleUnsubscribe(email, token, env);

  // Redirect to the friendly /unsubscribed page either way — we don't want
  // to expose backend error details to drive-by clickers.
  // ?ok=1 / ?ok=0 lets the page show a slightly different message.
  const redirect = new URL("/unsubscribed", SITE_ORIGIN);
  redirect.searchParams.set("ok", result.ok ? "1" : "0");
  if (email && result.ok) {
    redirect.searchParams.set("email", email);
  }
  return Response.redirect(redirect.toString(), 302);
};

// ---- POST handler (RFC 8058 one-click from Gmail/Yahoo/Apple Mail) ----

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Per RFC 8058, the body is application/x-www-form-urlencoded with at
  // minimum `List-Unsubscribe=One-Click`. We include `email` and `token`
  // in the URL query string of the POST endpoint so we know who's
  // unsubscribing.
  const url = new URL(request.url);
  let email = (url.searchParams.get("email") || "").trim().toLowerCase();
  let token = (url.searchParams.get("token") || "").trim();

  // Some clients may put email/token in the body. Be defensive.
  if (!email || !token) {
    try {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const body = await request.text();
        const params = new URLSearchParams(body);
        email = email || (params.get("email") || "").trim().toLowerCase();
        token = token || (params.get("token") || "").trim();
      }
    } catch {
      // ignore; we'll fail in handleUnsubscribe
    }
  }

  const result = await handleUnsubscribe(email, token, env);

  // RFC 8058 says return 200 (OK) or 202 (Accepted) with an empty body.
  // We use 200 on success and 400 on bad input so monitoring can spot
  // misuse, but mail clients ignore status differences in practice.
  return new Response("", { status: result.ok ? 200 : 400 });
};
