# Ticket: Multi-platform streaming picker on Music page

## Goal
Let visitors play / save Vibin' Psybin releases on whatever streaming service they prefer. Currently the Music page only shows a "Listen on Spotify" button per release. Expand to show every major platform that has the track.

## Non-goals (for THIS ticket)
- Bandcamp embedded player — Joe is still uploading his catalog there. Leave a clean place to slot in `bandcampUrl` per-release later, but don't build the embed component now.
- No new pages, no nav changes, no design overhaul. Music page only.

## Approach
Use **song.link / Odesli's free public API** (`https://api.song.link/v1-alpha.1/links?url=<spotify-url>&userCountry=US`) to resolve each release to its links on all major platforms. Pull at build time (same pattern as Spotify lib), cache, render.

API docs: https://www.notion.so/odesli/Public-API-d8499e9a513e4c8ab7ae2c69afc1ea2c
Rate limit: 10 req/min unverified, no key needed for public use. Our build hits ~15 releases — well within limits, but add a 1s sleep between requests to be safe.

Platforms to surface (order matters for UX):
1. Spotify (primary — already there)
2. Apple Music
3. YouTube Music
4. Tidal
5. Amazon Music
6. Deezer
7. Pandora
8. SoundCloud (if present)

Skip: anghami, audiomack, napster, yandex (low US relevance).

## Acceptance criteria

1. **New file `src/lib/songlink.ts`** — typed Odesli API client.
   - Function `fetchPlatformLinks(spotifyUrl: string): Promise<PlatformLinks>` returning `{ spotify, appleMusic, youtubeMusic, tidal, amazonMusic, deezer, pandora, soundcloud }` with each value being a URL or `null`.
   - Errors must NOT throw — return all-nulls on any failure. Site must never break because Odesli is slow/down.
   - Add reasonable timeout (5s per request).
   - Console.log clear progress: `[songlink] fetching <album> ...` and `[songlink] resolved 6/8 platforms`.

2. **`src/lib/spotify.ts` extended**:
   - The `NormalizedRelease` interface gets a new optional field `platformLinks: PlatformLinks | null`.
   - In `fetchSpotifyReleases()`, after building each release, call `fetchPlatformLinks(release.spotifyUrl)` and attach. Add 1s `await sleep` between calls.

3. **`src/pages/music.astro` updated**:
   - Replace the existing single "Listen on Spotify" button with a horizontal row of platform buttons / icons.
   - Each platform link only renders if the URL exists (skip null entries).
   - Spotify stays first / primary styled. Others are smaller secondary buttons.
   - Use simple text labels (e.g. "Apple Music"). Icon SVGs are nice-to-have but not required for v1.
   - Mobile: row should wrap, not horizontal-scroll.

4. **Fallback safety**:
   - When `release.platformLinks` is null, fall back to current behavior (just Spotify button).
   - When `release.spotifyUrl` is missing, still don't break — show "Streaming links coming soon" exactly as today.

5. **Add Bandcamp seam (data only)**:
   - `NormalizedRelease` also gets `bandcampUrl: string | null` (default null).
   - Render a "Bandcamp" button in the platform row when present.
   - Source: Read from a NEW file `src/data/release-overrides.json` that maps `spotifyAlbumId` → `{ bandcampUrl?: string }`. File is git-tracked. Joe will populate later. For NOW the file should exist with `{}` and a comment explaining the shape.

6. **QA**:
   - `npm run build` exits 0.
   - All releases on https://vibinpsybin.band/music render with at least Spotify + Apple Music links (Odesli has Apple coverage for everything on Spotify).
   - "The Ride" specifically shows links to multiple platforms.
   - Mobile width 375px: platform buttons wrap cleanly, don't overflow.
   - `bash scripts/verify-deploy.sh https://vibinpsybin.band` passes.

7. **Branch + PR**:
   - Branch `feat/streaming-picker`.
   - Commit messages prefixed `feat(music):` and `feat(lib):` appropriately.
   - PR title: "feat(music): multi-platform streaming picker (song.link/Odesli)".
   - PR body: link to this ticket, include before/after screenshots (use `npm run preview` and curl-fetch the music page to verify HTML).

## Workflow rules (per Music project policy)
- Implementer: ship the PR, do NOT auto-merge.
- Separate QA sub-agent: clones branch, runs verification, must independently confirm 7 acceptance criteria. Cortana orchestrates.
- Auto-merge OK after QA green per `projects/music.md` policy ("PR auto-merge is OK for this project").
- Post-merge deploy + post-deploy verify-deploy.sh must run before reporting "live" to Joe.

## Useful refs
- Odesli API: https://api.song.link/v1-alpha.1/links?url=https%3A%2F%2Fopen.spotify.com%2Falbum%2F372PbPefzKQ2XOEO5miRJy
- Existing Spotify lib pattern: `src/lib/spotify.ts`
- Music page: `src/pages/music.astro`
- Cloudflare deploy: see `projects/music.md` "Deploy command (manual)" block. Token rotated 2026-04-28, in `.secrets/music.env` as `CLOUDFARE_API_KEY`.
