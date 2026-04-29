// iTunes Search API client — Apple Music fallback resolver.
//
// Why this exists: Odesli (song.link) consistently fails to match Joe's
// Spotify releases to Apple Music, even though every release IS on Apple
// Music. This module hits the public iTunes Search API directly to fill
// the gap for releases where Odesli came back empty for `appleMusic`.
//
// API: https://itunes.apple.com/search?term=<q>&entity=album&limit=<n>
// - No auth required, no rate limit headache for our scale (Apple's docs
//   say "no more than 20 calls/sec"; we do ~13 calls per build).
// - Returns `collectionViewUrl` like
//   `https://music.apple.com/us/album/<slug>/<id>?uo=4`.
//   We strip the `?uo=4` to get a clean canonical URL.
//
// Conservative match logic — we'd rather return null than the wrong album:
// 1. Title match: case-insensitive, after normalizing both sides
//    (strip "- Single" / "- EP" suffixes, parens, "feat." tags, punctuation,
//     extra whitespace).
// 2. Artist match: case-insensitive substring match either way ("Psybin"
//    matches "Vibin' Psybin and the Sunlight Band & Psybin", and vice
//    versa).
//
// Failure mode: every error path returns null and logs a warning.
// We never want to fail the build because Apple's search hiccupped.

const ITUNES_BASE = "https://itunes.apple.com/search";
const REQUEST_TIMEOUT_MS = 5_000;

interface ItunesAlbum {
  collectionId: number;
  collectionName: string;
  artistName: string;
  collectionViewUrl: string;
  collectionType?: string;
}

interface ItunesSearchResponse {
  resultCount: number;
  results: ItunesAlbum[];
}

/**
 * Normalize a title or artist for comparison.
 * - lowercase
 * - strip "- Single" / "- EP" / "(EP)" suffixes
 * - strip parens and "feat." tags
 * - collapse punctuation/whitespace
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    // strip parenthetical/bracketed content (e.g. "(feat. X)", "[Live]")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    // strip trailing "- Single" / "- EP" / " EP" markers
    .replace(/\s*[-–—]\s*(single|ep)\s*$/i, " ")
    .replace(/\s+ep\s*$/i, " ")
    // strip "feat." / "ft." segments not in parens
    .replace(/\s+(feat\.?|ft\.?)\s+.*$/i, " ")
    // collapse anything non-alphanumeric to spaces (handles apostrophes,
    // ampersands, slashes, etc. — important so "Vibin' Psybin" matches
    // "Vibin Psybin" and "Live Fast/Headlights" doesn't trip on the slash)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Title match: exact equality after normalization.
 * Conservative on purpose — we don't fuzzy-match because false positives
 * (wrong album linked) are way worse than false negatives (no link shown).
 */
function titleMatches(queryTitle: string, candidateTitle: string): boolean {
  const a = normalize(queryTitle);
  const b = normalize(candidateTitle);
  if (!a || !b) return false;
  return a === b;
}

/**
 * Artist match: substring either direction (case-insensitive, normalized).
 * "Psybin" should match "Vibin Psybin and the Sunlight Band & Psybin",
 * and "Vibin Psybin" should match an iTunes-side artist of just "Psybin".
 */
function artistMatches(queryArtist: string, candidateArtist: string): boolean {
  const a = normalize(queryArtist);
  const b = normalize(candidateArtist);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Strip Apple's `?uo=4` (and any other query params) for a clean canonical
 * URL we can ship in the Listen dropdown.
 */
function cleanAppleMusicUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    return u.toString();
  } catch {
    // Fallback: dumb-strip everything from the first `?` onward.
    const q = url.indexOf("?");
    return q >= 0 ? url.slice(0, q) : url;
  }
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Search iTunes for a given album/single by title + artist and return the
 * canonical Apple Music URL when we find a confident match. Returns null
 * (and logs a warning) on any kind of failure or ambiguous result.
 *
 * We use the title as the primary search term — artist names alone return
 * everything in the catalog and we'd have to wade through pagination. By
 * searching for the title and filtering by artist on the client, we get
 * a small, focused result set.
 */
export async function findAppleMusicAlbumUrl(
  artist: string,
  title: string,
): Promise<string | null> {
  if (!artist || !title) return null;

  // Build the search term: title is the strongest signal. Adding the
  // artist string narrows it further.
  const term = `${title} ${artist}`.trim();
  const url = `${ITUNES_BASE}?term=${encodeURIComponent(term)}&entity=album&limit=20&country=us`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[itunes] request failed for "${title}": ${msg}`);
    return null;
  }
  if (!res.ok) {
    console.warn(
      `[itunes] non-OK response for "${title}": ${res.status} ${res.statusText}`,
    );
    return null;
  }

  let data: ItunesSearchResponse;
  try {
    data = (await res.json()) as ItunesSearchResponse;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[itunes] JSON parse failed for "${title}": ${msg}`);
    return null;
  }

  const candidates = (data.results || []).filter(
    (r) => r && typeof r.collectionViewUrl === "string",
  );
  if (candidates.length === 0) {
    return null;
  }

  // Prefer exact title + artist match. If multiple match (e.g. duplicate
  // releases on different labels), take the first — iTunes generally
  // returns the most relevant first.
  const matches = candidates.filter(
    (r) =>
      titleMatches(title, r.collectionName) &&
      artistMatches(artist, r.artistName),
  );

  if (matches.length === 0) {
    return null;
  }

  return cleanAppleMusicUrl(matches[0].collectionViewUrl);
}

// --- Public batch helper used by spotify.ts ---

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Separate cache file from .songlink-cache.json. Keyed by Spotify album ID
// (NOT URL — IDs are stable, URLs aren't) so we can survive any future
// Spotify URL format change. Schema:
//   { "<spotifyAlbumId>": { fetchedAt: ISO, appleMusicUrl: string | null } }
// A null appleMusicUrl is still cached (with a separate "noMatch" flag) so
// we don't waste a build retrying a release that genuinely isn't on iTunes.
const CACHE_PATH = resolve(process.cwd(), ".itunes-cache.json");

interface ItunesCacheEntry {
  fetchedAt: string;
  appleMusicUrl: string | null;
  noMatch?: boolean; // true when the lookup completed but found no match
}

type ItunesCacheShape = Record<string, ItunesCacheEntry>;

let cache: ItunesCacheShape = {};
let cacheLoaded = false;
let cacheDirty = false;

function loadCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    if (existsSync(CACHE_PATH)) {
      const raw = readFileSync(CACHE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        cache = parsed as ItunesCacheShape;
        console.log(
          `[itunes] cache loaded: ${Object.keys(cache).length} entries from ${CACHE_PATH}`,
        );
      }
    } else {
      console.log(`[itunes] no cache file at ${CACHE_PATH}; starting fresh`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[itunes] cache load failed (${msg}); ignoring`);
    cache = {};
  }
}

function flushCache(): void {
  if (!cacheDirty) return;
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n", "utf8");
    cacheDirty = false;
    console.log(
      `[itunes] cache written: ${Object.keys(cache).length} entries -> ${CACHE_PATH}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[itunes] cache write failed: ${msg}`);
  }
}

/**
 * Resolve an Apple Music URL for a single release, with disk-backed caching.
 * - albumId is the Spotify album ID (the stable cache key).
 * - Returns null when there's no match or the lookup failed.
 */
async function resolveAppleMusicUrl(
  albumId: string,
  artist: string,
  title: string,
): Promise<string | null> {
  loadCache();
  const cached = cache[albumId];
  if (cached) {
    return cached.appleMusicUrl;
  }
  const url = await findAppleMusicAlbumUrl(artist, title);
  cache[albumId] = {
    fetchedAt: new Date().toISOString(),
    appleMusicUrl: url,
    noMatch: url === null,
  };
  cacheDirty = true;
  return url;
}

/**
 * Shape we expect from the caller. Kept structurally minimal so this
 * module doesn't have to import from spotify.ts (would create a cycle).
 */
interface ReleaseLikeForItunes {
  id: string;
  title: string;
  artist: string;
  platformLinks: { appleMusic: string | null } | null;
}

/**
 * Fill in `platformLinks.appleMusic` from iTunes for any release where
 * Odesli didn't already give us a value. Mutates the input array entries
 * in place. Logs progress and a final summary line.
 *
 * Politeness: ~150ms between requests so we never get close to Apple's
 * 20 req/sec ceiling, and we don't burst-fire on cold-cache builds.
 */
export async function fillAppleMusicGaps(
  releases: ReleaseLikeForItunes[],
): Promise<void> {
  const targets = releases.filter(
    (r) => r.platformLinks && !r.platformLinks.appleMusic,
  );
  const total = targets.length;
  if (total === 0) {
    console.log(
      `[itunes] all ${releases.length} releases already have Apple Music links from Odesli; nothing to fill`,
    );
    return;
  }
  console.log(
    `[itunes] resolving Apple Music URLs for ${total} release(s) missing Odesli appleMusic ...`,
  );

  let resolved = 0;
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    try {
      const url = await resolveAppleMusicUrl(r.id, r.artist, r.title);
      if (url && r.platformLinks) {
        r.platformLinks.appleMusic = url;
        resolved += 1;
        console.log(`[itunes] ${r.title}: matched ${url}`);
      } else {
        console.warn(`[itunes] ${r.title}: no match (skipped)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[itunes] ${r.title}: error during lookup: ${msg}`);
    }
    // Polite pacing — only sleep if we just made a network call (cache
    // hits return synchronously and don't need throttling).
    if (i < targets.length - 1 && !cache[r.id]?.fetchedAt) {
      // Already cached above; skip sleep on hits.
    }
    // Cheap and effective: small fixed delay between iterations.
    if (i < targets.length - 1) {
      await new Promise((res) => setTimeout(res, 150));
    }
  }

  flushCache();
  console.log(`[itunes] resolved ${resolved}/${total} releases`);
}
