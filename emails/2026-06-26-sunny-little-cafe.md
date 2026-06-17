# Sunny Little Café — release-day email

**Send:** June 26, 2026 (release day, once track is live on streaming)
**From:** Vibin' Psybin <hello@vibinpsybin.band>
**Reply-To:** vibinpsybin@gmail.com
**Audience:** Resend audience `ce346ff2-9997-4801-a1e1-491cdba60c73` (vibinpsybin-site fans)
**Subject options (pick one):**
1. Sunny Little Café is out 🌞
2. New single: Sunny Little Café
3. Sunny Little Café — out now everywhere

**Preview text:** A little warmth for your morning. Streaming everywhere starting today.

---

## Plain text body

Hey —

Sunny Little Café is live on streaming today.

If you've been with us on Bandcamp, you've heard it as track 9 on Reflections. Today it gets its own little spotlight out in the wider world — Spotify, Apple Music, all the usual spots.

It's a warm one. Pour a cup of something, hit play, send it to someone who needs a little sunshine today.

→ Listen: https://vibinpsybin.band/links

Thanks for being on this list. You're the whole reason any of this works.

— Joe
Vibin' Psybin and the Sunlight Band

P.S. If you want the full record, it's still right here: https://vibinpsybinandthesunlightband.bandcamp.com/album/reflections

---

## HTML version (matches plain text — keep simple)

```html
<p>Hey —</p>

<p><strong>Sunny Little Café</strong> is live on streaming today.</p>

<p>If you've been with us on Bandcamp, you've heard it as track 9 on <em>Reflections</em>. Today it gets its own little spotlight out in the wider world — Spotify, Apple Music, all the usual spots.</p>

<p>It's a warm one. Pour a cup of something, hit play, send it to someone who needs a little sunshine today.</p>

<p><a href="https://vibinpsybin.band/links">→ Listen</a></p>

<p>Thanks for being on this list. You're the whole reason any of this works.</p>

<p>— Joe<br/>
<em>Vibin' Psybin and the Sunlight Band</em></p>

<p style="font-size: 14px; color: #888;">
P.S. If you want the full record, it's still right here:
<a href="https://vibinpsybinandthesunlightband.bandcamp.com/album/reflections">Reflections on Bandcamp</a>
</p>
```

---

## Pre-send checklist (do this morning of June 26)

- [ ] Confirm Sunny Little Café is actually live on Spotify + Apple Music (don't send until verified)
- [ ] Update `https://vibinpsybin.band/links` so Sunny Little Café shows the streaming options (Spotify/Apple/etc.)
  - Easiest: add a `manual-releases.json` entry for the single, OR wait for next Spotify sync + verify the streaming picker resolves it via Odesli
- [ ] Pick a subject line
- [ ] Decide: send via Resend Broadcasts API or paste into Resend dashboard for one-click QA preview
- [ ] List-Unsubscribe headers must be present (handled automatically by /api/welcome path; if sending via Broadcasts, verify Resend includes them)
- [ ] Hit send

## How to actually send (Resend Broadcasts API)

```bash
# from repo root, with .secrets/music.env loaded
curl -X POST 'https://api.resend.com/broadcasts' \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "audience_id": "ce346ff2-9997-4801-a1e1-491cdba60c73",
  "from": "Vibin' Psybin <hello@vibinpsybin.band>",
  "reply_to": "vibinpsybin@gmail.com",
  "subject": "Sunny Little Café is out 🌞",
  "html": "...HTML from above...",
  "text": "...plain text from above..."
}
JSON

# Then send the broadcast:
# curl -X POST "https://api.resend.com/broadcasts/<id>/send" -H "Authorization: Bearer $RESEND_API_KEY"
```

Or just paste into the Resend dashboard, preview, and click send — same outcome, fewer moving parts.
