# Testing & Deploy Verification

This repo ships with a lightweight, zero-dependency deploy verification harness
that checks every deploy against the live site. It's what QA runs to decide
whether a push actually went out cleanly.

## `scripts/verify-deploy.sh`

Bash script. Only uses `curl` + standard *nix text tools. No `npm install`
required.

### Run it

```bash
# Against prod (default)
./scripts/verify-deploy.sh

# Against any other deploy (preview, staging, local dev)
./scripts/verify-deploy.sh https://vibinpsybin.band
./scripts/verify-deploy.sh https://staging.vibinpsybin.band
./scripts/verify-deploy.sh http://localhost:4321
```

Exit code is `0` on all-green and `1` on any failure, so you can wire it into
CI or a post-deploy hook without reading the output:

```bash
./scripts/verify-deploy.sh && echo "Deploy OK"
```

### What it checks

| # | Check | Pass condition |
|---|-------|---------------|
| 1 | Every HTML page loads — `/`, `/music`, `/shows`, `/videos`, `/contact`, `/producer` | Follows redirects; final response must be `200` |
| 2 | Every `src="..."` and every URL inside every `srcset="..."` (across all pages) | Probed with HEAD (falls back to a ranged GET if HEAD is blocked); final response must be `200` |
| 3 | Every `<link rel="stylesheet">` | `200` |
| 4 | Every internal `<a href="/...">` link | `200` |
| 5 | Shows section on `/` and `/shows` | Page contains either (a) at least one rendered show entry, or (b) the documented empty-state copy ("Shows pulled live from Bandsintown..." / "no upcoming shows"). A shows *section* with neither entries nor empty-state copy is flagged as broken. |
| 6 | Summary with pass/fail counts | Exit `0` iff `fail == 0` |

HTML entity decoding (`&amp;`, `&#38;`) is handled so Astro's
`/_image?href=...&w=...` URLs probe correctly.

### What it deliberately does *not* check

These need human eyes (or a real browser) — run through this checklist
manually after any meaningful visual change:

- **Visual regression** — does the site *look* right? (layout, spacing,
  typography, colors, dark-mode)
- **Responsive breakpoints** — resize the browser from ~320px to 1920px
- **Animations** — aurora blobs, grain overlay, scroll hints all moving
- **Hero images** — correct crop / focal point on mobile
- **Navigation** — sticky header, active-link highlighting
- **Email signup form** — submit a throwaway address, confirm the success
  state renders and the POST to `/api/subscribe` returns 200
- **Audio/video embeds** — Apple Music, YouTube, etc. actually play
- **Fonts** — Google Fonts load before paint (no FOIT)
- **SEO tags** — spot-check `<title>`, `og:image`, `og:description` on each
  page
- **Real shows rendering** — when Bandsintown has actual upcoming shows,
  confirm dates/venues/lineup render correctly (the harness only checks that
  *something* is there)
- **JS console errors** — open devtools on each page and confirm no red
  errors (the harness doesn't run JS)

## When to run

- Before merging any PR that touches `src/`, `public/`, `astro.config.mjs`,
  or the deploy pipeline
- Immediately after every prod deploy
- As a smoke test when something "feels off" in production
