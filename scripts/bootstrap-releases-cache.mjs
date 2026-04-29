// One-time bootstrap script: builds .releases-cache.json from existing
// .songlink-cache.json + .itunes-cache.json + per-album lookups against
// public iTunes / Spotify endpoints (no auth needed).
//
// Background: the new release-manifest cache (Fallback 1 in spotify.ts) is
// normally populated by a successful Spotify API fetch. But Spotify is rate
// limited right now (HTTP 429 with retry-after ~2h), so we can't seed it
// the normal way. This script reconstructs the cache from data we already
// have, so the next build can use it as Fallback 1 instead of degrading to
// the stale src/data/releases.json skeleton.
//
// Run: node scripts/bootstrap-releases-cache.mjs
//
// Safe to re-run: overwrites .releases-cache.json idempotently. Once Spotify
// is reachable again, a normal `npm run build` will refresh the cache with
// fully-canonical Spotify metadata.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());
const SONGLINK_CACHE = resolve(ROOT, ".songlink-cache.json");
const ITUNES_CACHE = resolve(ROOT, ".itunes-cache.json");
const OUTPUT = resolve(ROOT, ".releases-cache.json");

const ARTIST_IDS = [
  "40SRpqCKiQZZ3alrYeXAYR", // Psybin
  "16AgfIKYaZe0mmiAHuzVta", // Vibin' Psybin and the Sunlight Band
];

const HIDDEN_ALBUM_IDS = new Set([
  "74CfTR822eh6VGiJyccNct",
  "2umhMZ61vkt96y2yD1dsaA",
  "24fIqXw9dOn6P2zEBFskbV",
  "7snksh4HsQhprvFB8cPi9s",
  "5eocqaLyIyfEsou3RR3S1e",
  "5HmfzolN3eqSUB9wLodgFb",
  "2cSlJc8Fz5zdIY0Im5rDjo",
  "7zlkcsMJBLcCx97tPRr8YW",
  "4pcZ5EAZ3jqgMzsf0rRXjX",
]);

function emptyPlatformLinks() {
  return {
    spotify: null,
    appleMusic: null,
    youtubeMusic: null,
    tidal: null,
    amazonMusic: null,
    deezer: null,
    pandora: null,
    soundcloud: null,
  };
}

const songlinkRaw = existsSync(SONGLINK_CACHE)
  ? JSON.parse(readFileSync(SONGLINK_CACHE, "utf8"))
  : {};
const itunesRaw = existsSync(ITUNES_CACHE)
  ? JSON.parse(readFileSync(ITUNES_CACHE, "utf8"))
  : {};

// Build set of all known album IDs across both caches.
const albumIds = new Set();
for (const id of Object.keys(itunesRaw)) albumIds.add(id);
for (const url of Object.keys(songlinkRaw)) {
  const m = url.match(/album\/([^/?#]+)/);
  if (m) albumIds.add(m[1]);
}

console.log(`[bootstrap] ${albumIds.size} unique album IDs across caches`);

function classifyType(title) {
  const lower = title.toLowerCase();
  if (lower.includes(" - ep") || lower.endsWith(" ep") || lower.includes("(ep)")) return "ep";
  if (lower.includes(" - single") || lower.endsWith("- single")) return "single";
  return "album";
}

function cleanTitle(rawTitle) {
  // iTunes returns titles like "Live Fast - EP" / "The Ride - Single" — the
  // production normalizer strips these via classifyType + name match. To stay
  // consistent with what Spotify-live would store, strip the trailing
  // suffix too.
  return rawTitle
    .replace(/\s*-\s*(EP|Single)\s*$/i, "")
    .trim();
}

async function fetchItunesLookup(appleId) {
  const url = `https://itunes.apple.com/lookup?id=${appleId}&entity=song&country=us`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes lookup ${appleId} -> ${res.status}`);
  const data = await res.json();
  const album = data.results.find((r) => r.wrapperType === "collection");
  const tracks = data.results
    .filter((r) => r.wrapperType === "track")
    .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber));
  if (!album) throw new Error(`iTunes lookup ${appleId} -> no collection`);
  return {
    title: cleanTitle(album.collectionName),
    rawTitle: album.collectionName,
    artist: album.artistName,
    releaseDate: album.releaseDate ? album.releaseDate.slice(0, 10) : null,
    coverUrl: album.artworkUrl100
      ? album.artworkUrl100.replace("100x100bb", "640x640bb")
      : null,
    trackNames: tracks.map((t) => t.trackName),
  };
}

async function fetchSpotifyOEmbedTitle(albumId) {
  // Public, no auth. Returns at least the title.
  const url = `https://open.spotify.com/oembed?url=https://open.spotify.com/album/${albumId}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const m = data.html && data.html.match(/title="Spotify Embed: ([^"]+)"/);
  return {
    title: m ? m[1] : null,
    thumbnail: data.thumbnail_url || null,
  };
}

async function fetchSpotifyHtmlReleaseDate(albumId) {
  const url = `https://open.spotify.com/album/${albumId}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/"release_date":"(\d{4}-\d{2}-\d{2})"/);
  return m ? m[1] : null;
}

function getSonglinkLinksForAlbum(albumId) {
  const url = `https://open.spotify.com/album/${albumId}`;
  const entry = songlinkRaw[url];
  if (entry && entry.links) return entry.links;
  return emptyPlatformLinks();
}

function applyItunesAppleMusic(links, albumId) {
  const ie = itunesRaw[albumId];
  if (ie && ie.appleMusicUrl && !links.appleMusic) {
    links.appleMusic = ie.appleMusicUrl;
  }
  return links;
}

const releases = [];

for (const albumId of albumIds) {
  if (HIDDEN_ALBUM_IDS.has(albumId)) {
    console.log(`[bootstrap] hiding ${albumId} (in HIDDEN_ALBUM_IDS)`);
    continue;
  }
  const itunesEntry = itunesRaw[albumId];
  const spotifyUrl = `https://open.spotify.com/album/${albumId}`;
  let title = null;
  let artist = null;
  let releaseDate = null;
  let coverUrl = null;
  let trackNames = [];
  let type = "single";

  // Try iTunes lookup first — gives us full metadata.
  if (itunesEntry && itunesEntry.appleMusicUrl) {
    const m = itunesEntry.appleMusicUrl.match(/album\/[^/]+\/(\d+)/);
    if (m) {
      try {
        const meta = await fetchItunesLookup(m[1]);
        title = meta.title;
        artist = meta.artist;
        releaseDate = meta.releaseDate;
        coverUrl = meta.coverUrl;
        trackNames = meta.trackNames;
        type = classifyType(meta.rawTitle);
        console.log(`[bootstrap] ${albumId}: iTunes "${title}" (${releaseDate}, ${trackNames.length} tracks)`);
      } catch (e) {
        console.warn(`[bootstrap] ${albumId}: iTunes lookup failed: ${e.message}`);
      }
    }
  }

  // Fall back to Spotify oEmbed + HTML scrape for missing data.
  if (!title || !releaseDate) {
    try {
      const oembed = await fetchSpotifyOEmbedTitle(albumId);
      if (oembed && oembed.title) {
        title = title || oembed.title;
        coverUrl = coverUrl || oembed.thumbnail;
        type = type || classifyType(oembed.title);
      }
    } catch (e) {
      console.warn(`[bootstrap] ${albumId}: oEmbed failed: ${e.message}`);
    }
    try {
      const date = await fetchSpotifyHtmlReleaseDate(albumId);
      if (date) releaseDate = date;
    } catch (e) {
      console.warn(`[bootstrap] ${albumId}: HTML date failed: ${e.message}`);
    }
    if (!artist) {
      // Heuristic: if any songlink entry came from the Vibin' band catalog,
      // tag it as the band. Otherwise solo.
      // Default to Psybin (solo) for these early-era leftovers.
      artist = "Psybin";
    }
    console.log(`[bootstrap] ${albumId}: scraped fallback "${title}" (${releaseDate})`);
  }

  if (!title) {
    console.warn(`[bootstrap] ${albumId}: no title resolvable; skipping`);
    continue;
  }

  const year = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : 0;

  // Build platformLinks: songlink first, then iTunes Apple Music gap-fill.
  const platformLinks = applyItunesAppleMusic(
    getSonglinkLinksForAlbum(albumId),
    albumId,
  );
  // Make sure spotify slot is set.
  if (!platformLinks.spotify) platformLinks.spotify = spotifyUrl;

  releases.push({
    id: albumId,
    title,
    artist,
    year,
    type,
    coverUrl,
    spotifyUrl,
    trackNames,
    releaseDate: releaseDate || `${year}-01-01`,
    platformLinks,
    bandcampUrl: null,
  });

  // Polite pacing for the public endpoints.
  await new Promise((r) => setTimeout(r, 200));
}

releases.sort((a, b) => (a.releaseDate < b.releaseDate ? 1 : -1));

const payload = {
  version: 1,
  lastUpdated: new Date().toISOString(),
  artistIds: ARTIST_IDS,
  releases,
  _bootstrapNote:
    "Initial seed produced by scripts/bootstrap-releases-cache.mjs while Spotify API was rate-limited. Will be replaced by canonical Spotify metadata on the next successful build.",
};

writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`[bootstrap] wrote ${releases.length} releases -> ${OUTPUT}`);
