# vibinpsybin.band

Official site for **Vibin' Psybin and the Sunlight Band** (and Joe's solo Psybin project).

Nashville-based psychedelic cosmic country. Direct-to-fan. No social media dependency.

## Stack

- **[Astro](https://astro.build)** — static site generator, MPA, zero JS by default
- **Cloudflare Pages** — hosting + serverless functions
- **Buttondown** — email list provider (`/api/subscribe`)
- **Bandcamp / YouTube / Bandsintown** — external data via embeds / APIs

No database, no CMS. Site content lives in `src/data/*.json` and `src/pages/*.astro`. Git is the admin panel.

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:4321.

## Adding a show

Edit `src/data/shows.json`. Shape:

```json
{
  "date": "2026-07-12T19:00:00-05:00",
  "venue": "Exit/In",
  "city": "Nashville, TN",
  "ticketUrl": "https://...",
  "notes": "Full band."
}
```

Commit + push. Cloudflare Pages rebuilds in ~30s.

## Adding a release

Edit `src/data/releases.json`.

## Adding a video

Edit `src/data/videos.json`. `youtubeId` is the `v=...` parameter from the YouTube URL.

## Secrets

`BUTTONDOWN_API_KEY` is set in Cloudflare Pages environment variables. Never committed.

## Deploy

Pushes to `main` auto-deploy via Cloudflare Pages.
