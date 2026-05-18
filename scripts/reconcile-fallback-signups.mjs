#!/usr/bin/env node
// reconcile-fallback-signups.mjs
//
// When Buttondown is degraded, /api/subscribe falls back to emailing Joe via
// Resend with a "🎸 New subscriber needs manual add: <email>" subject. This
// script reads those Resend captures, extracts the addresses, and re-tries
// adding them to Buttondown now that the API is presumably healthy.
//
// Usage:
//   set -a && source ../../.secrets/music.env && set +a
//   node scripts/reconcile-fallback-signups.mjs           # dry-run, prints plan
//   node scripts/reconcile-fallback-signups.mjs --apply   # actually add to Buttondown
//
// Requires: RESEND_API_KEY, BUTTONDOWN_API_KEY (from music.env).

const APPLY = process.argv.includes("--apply");
const SUBJECT_PREFIX = "🎸 New subscriber needs manual add:";
const RESEND = process.env.RESEND_API_KEY;
const BUTTONDOWN = process.env.BUTTONDOWN_API_KEY;

if (!RESEND || !BUTTONDOWN) {
  console.error("Missing RESEND_API_KEY or BUTTONDOWN_API_KEY in env.");
  process.exit(1);
}

const log = (...a) => console.log(...a);

// 1. Pull the last 100 emails from Resend.
log("[reconcile] fetching recent Resend emails…");
const res = await fetch("https://api.resend.com/emails?limit=100", {
  headers: { Authorization: `Bearer ${RESEND}` },
});
if (!res.ok) {
  console.error("Resend fetch failed:", res.status, await res.text().catch(() => ""));
  process.exit(1);
}
const data = await res.json();
const emails = (data.data || data || []).filter((e) =>
  (e.subject || "").startsWith(SUBJECT_PREFIX),
);
log(`[reconcile] found ${emails.length} fallback-capture emails in Resend`);

// 2. Extract subscriber emails from subjects.
const addresses = [
  ...new Set(
    emails
      .map((e) => (e.subject || "").slice(SUBJECT_PREFIX.length).trim())
      .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)),
  ),
];
log(`[reconcile] ${addresses.length} unique addresses to reconcile:`);
for (const a of addresses) log("   -", a);

if (!APPLY) {
  log("\n[reconcile] dry-run only. Re-run with --apply to actually add them.");
  process.exit(0);
}

// 3. Add each to Buttondown.
let ok = 0,
  already = 0,
  blocked = 0,
  failed = 0;
for (const email of addresses) {
  const r = await fetch("https://api.buttondown.email/v1/subscribers", {
    method: "POST",
    headers: {
      Authorization: `Token ${BUTTONDOWN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email_address: email, tags: ["vibinpsybin-site", "reconciled"] }),
  });
  if (r.status === 201 || r.status === 200) {
    log(`  ✅ added: ${email}`);
    ok++;
  } else if (r.status === 400) {
    const body = await r.json().catch(() => ({}));
    const detail = (body.detail || body.code || "").toLowerCase();
    if (detail.includes("already")) {
      log(`  🔁 already subscribed: ${email}`);
      already++;
    } else if (detail.includes("firewall") || detail.includes("blocked")) {
      log(`  🚫 still firewalled by Buttondown: ${email} (${body.code || body.detail})`);
      blocked++;
    } else {
      log(`  ❌ 400 error: ${email} (${body.code || body.detail})`);
      failed++;
    }
  } else {
    const txt = await r.text().catch(() => "");
    log(`  ❌ ${r.status}: ${email} (${txt.slice(0, 120)})`);
    failed++;
  }
  // Be gentle.
  await new Promise((res) => setTimeout(res, 500));
}

log(`\n[reconcile] done. added=${ok} already=${already} blocked=${blocked} failed=${failed}`);
if (blocked > 0) {
  log("[reconcile] note: addresses still firewalled by Buttondown's anti-abuse system");
  log("   need to be added manually via the Buttondown dashboard, or accept that they're");
  log("   genuinely bad addresses. There's no API path around the firewall.");
}
