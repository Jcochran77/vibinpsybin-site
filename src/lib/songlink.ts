// song.link / Odesli public API client.
// Resolves a Spotify URL to its equivalents on every major streaming platform.
//
// Docs: https://www.notion.so/odesli/Public-API-d8499e9a513e4c8ab7ae2c69afc1ea2c
// Endpoint: GET https://api.song.link/v1-alpha.1/links?url=<spotify-url>&userCountry=US
// Rate limit: 10 req/min unverified — caller throttles between calls.
//
// Persistent cache: results are written to .songlink-cache.json at the repo
// root and read on subsequent builds. New/changed Spotify URLs trigger a
// fresh Odesli fetch; everything else is instant. The cache is git-tracked
// so CI builds (Cloudflare Pages) don't blow the rate limit on every push.
//
// Fail-safe by design: ALL errors return an all-nulls PlatformLinks object.
// The site must never break because Odesli is slow or unreachable.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ODESLI_BASE = "https://api.song.link/v1-alpha.1/links";
const USER_COUNTRY = "US";
const REQUEST_TIMEOUT_MS = 5_000;
// Odesli unverified rate limit is 10 req/min. We retry 429s up to MAX_RETRIES
// times, backing off exponentially (capped) so we don't spam.
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 8_000;

// Cache file lives at repo root: <repo>/.songlink-cache.json. We resolve via
// process.cwd() because the build runs with cwd at the repo root and bundlers
// can move/inline import.meta.url unpredictably.
const CACHE_PATH = resolve(process.cwd(), ".songlink-cache.json");

interface CacheEntry {
  fetchedAt: string; // ISO timestamp
  links: PlatformLinks;
}

type CacheShape = Record<string, CacheEntry>;

let cacheLoaded = false;
let cache: CacheShape = {};
let cacheDirty = false;

function loadCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    if (existsSync(CACHE_PATH)) {
      const raw = readFileSync(CACHE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        cache = parsed as CacheShape;
        const n = Object.keys(cache).length;
        console.log(`[songlink] cache loaded: ${n} entries from ${CACHE_PATH}`);
      }
    } else {
      console.log(`[songlink] no cache file at ${CACHE_PATH}; starting fresh`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[songlink] cache load failed (${msg}); ignoring`);
    cache = {};
  }
}

/**
 * Flush the in-memory cache to disk. Caller decides when to checkpoint;
 * spotify.ts calls this after the batch completes so partial work is saved.
 */
export function flushPlatformLinkCache(): void {
  if (!cacheDirty) return;
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n", "utf8");
    cacheDirty = false;
    const n = Object.keys(cache).length;
    console.log(`[songlink] cache written: ${n} entries -> ${CACHE_PATH}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[songlink] cache write failed: ${msg}`);
  }
}

/**
 * Platform link slots we surface in the UI.
 * Order here = display priority order in the picker.
 * Spotify stays first/primary.
 */
export interface PlatformLinks {
  spotify: string | null;
  appleMusic: string | null;
  youtubeMusic: string | null;
  tidal: string | null;
  amazonMusic: string | null;
  deezer: string | null;
  pandora: string | null;
  soundcloud: string | null;
}

export function emptyPlatformLinks(): PlatformLinks {
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

// --- Odesli response shape (partial) ---
//
// Odesli returns a `linksByPlatform` map keyed by platform name.
// Each entry has at minimum `url`, sometimes `nativeAppUriMobile`/`nativeAppUriDesktop`.
// We only need `url`.

interface OdesliPlatformEntry {
  url: string;
  entityUniqueId?: string;
}

interface OdesliResponse {
  entityUniqueId?: string;
  userCountry?: string;
  pageUrl?: string;
  linksByPlatform?: Record<string, OdesliPlatformEntry | undefined>;
}

// Map Odesli platform keys → our PlatformLinks fields.
// Odesli platform key ref: spotify, appleMusic, youtube, youtubeMusic, tidal,
// amazonMusic, amazonStore, deezer, pandora, soundcloud, anghami, audiomack,
// audius, boomplay, napster, yandex, ...
//
// We intentionally skip anghami / audiomack / napster / yandex per ticket.
const PLATFORM_KEY_MAP: Record<keyof PlatformLinks, string[]> = {
  // Try multiple Odesli keys per slot in case naming varies. First match wins.
  spotify: ["spotify"],
  appleMusic: ["appleMusic"],
  youtubeMusic: ["youtubeMusic", "youtube"],
  tidal: ["tidal"],
  amazonMusic: ["amazonMusic", "amazonStore"],
  deezer: ["deezer"],
  pandora: ["pandora"],
  soundcloud: ["soundcloud"],
};

function pickUrl(
  byPlatform: Record<string, OdesliPlatformEntry | undefined>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const entry = byPlatform[k];
    if (entry && typeof entry.url === "string" && entry.url.length > 0) {
      return entry.url;
    }
  }
  return null;
}

function countResolved(p: PlatformLinks): number {
  return (Object.values(p) as (string | null)[]).filter(
    (v) => typeof v === "string" && v.length > 0,
  ).length;
}

/**
 * Sleep helper. Exported so callers (e.g. spotify.ts) can throttle.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Read-only cache lookup. Used when callers want to leverage existing data
 * without ever hitting the network (e.g. SKIP_ODESLI=1 mode).
 */
export function getCachedPlatformLinks(spotifyUrl: string): PlatformLinks | null {
  loadCache();
  const cached = cache[spotifyUrl];
  if (cached && cached.links) return cached.links;
  return null;
}

/**
 * Resolve a Spotify album/track URL to platform-specific URLs via Odesli.
 *
 * Never throws. On any failure (network, timeout, non-200, malformed JSON,
 * missing `linksByPlatform`), returns all-nulls. Caller can treat null
 * fields as "platform unavailable" and skip rendering.
 *
 * @param spotifyUrl Public Spotify URL (e.g. https://open.spotify.com/album/...).
 * @param label Optional short label used in console.log breadcrumbs.
 */
export async function fetchPlatformLinks(
  spotifyUrl: string,
  label?: string,
): Promise<PlatformLinks> {
  if (!spotifyUrl || typeof spotifyUrl !== "string") {
    console.warn("[songlink] no spotifyUrl provided; returning empty links");
    return emptyPlatformLinks();
  }

  loadCache();
  const cached = cache[spotifyUrl];
  if (cached && cached.links) {
    console.log(
      `[songlink] cache hit for ${label ?? spotifyUrl} (fetched ${cached.fetchedAt})`,
    );
    return cached.links;
  }

  const tag = label ? `[songlink] fetching ${label} ...` : `[songlink] fetching ${spotifyUrl} ...`;
  console.log(tag);

  const url = `${ODESLI_BASE}?url=${encodeURIComponent(spotifyUrl)}&userCountry=${USER_COUNTRY}`;

  let res: Response | null = null;
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Network/timeout failures get one retry with backoff before giving up.
      if (attempt < MAX_RETRIES) {
        const wait = BASE_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(
          `[songlink] request error for ${label ?? spotifyUrl} (attempt ${attempt + 1}): ${msg} — retrying in ${wait}ms`,
        );
        await sleep(wait);
        attempt += 1;
        continue;
      }
      console.warn(
        `[songlink] request failed for ${label ?? spotifyUrl}: ${msg} — returning empty links`,
      );
      return emptyPlatformLinks();
    }

    if (res.status !== 429) break;

    // 429: respect Retry-After if present, otherwise exponential backoff.
    const retryAfter = res.headers.get("retry-after");
    let waitMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (Number.isFinite(parsed) && parsed > 0) waitMs = parsed * 1000;
    }
    if (attempt >= MAX_RETRIES) {
      console.warn(
        `[songlink] still 429 after ${MAX_RETRIES + 1} attempts for ${label ?? spotifyUrl} — giving up`,
      );
      return emptyPlatformLinks();
    }
    console.warn(
      `[songlink] 429 for ${label ?? spotifyUrl} (attempt ${attempt + 1}); waiting ${waitMs}ms`,
    );
    await sleep(waitMs);
    attempt += 1;
  }

  if (!res || !res.ok) {
    const status = res ? `${res.status} ${res.statusText}` : "no response";
    console.warn(
      `[songlink] non-OK response for ${label ?? spotifyUrl}: ${status} — returning empty links`,
    );
    return emptyPlatformLinks();
  }

  let data: OdesliResponse;
  try {
    data = (await res.json()) as OdesliResponse;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[songlink] JSON parse failed for ${label ?? spotifyUrl}: ${msg} — returning empty links`,
    );
    return emptyPlatformLinks();
  }

  const byPlatform = data.linksByPlatform ?? {};
  const links: PlatformLinks = {
    spotify: pickUrl(byPlatform, PLATFORM_KEY_MAP.spotify),
    appleMusic: pickUrl(byPlatform, PLATFORM_KEY_MAP.appleMusic),
    youtubeMusic: pickUrl(byPlatform, PLATFORM_KEY_MAP.youtubeMusic),
    tidal: pickUrl(byPlatform, PLATFORM_KEY_MAP.tidal),
    amazonMusic: pickUrl(byPlatform, PLATFORM_KEY_MAP.amazonMusic),
    deezer: pickUrl(byPlatform, PLATFORM_KEY_MAP.deezer),
    pandora: pickUrl(byPlatform, PLATFORM_KEY_MAP.pandora),
    soundcloud: pickUrl(byPlatform, PLATFORM_KEY_MAP.soundcloud),
  };

  // If Odesli didn't echo back a Spotify URL but we know we asked for one,
  // fall back to the input so the primary CTA always works.
  if (!links.spotify) links.spotify = spotifyUrl;

  const total = Object.keys(links).length;
  const resolved = countResolved(links);
  console.log(
    `[songlink] resolved ${resolved}/${total} platforms${label ? ` for ${label}` : ""}`,
  );

  // Only cache successful resolutions (>=2 platforms). All-empty results are
  // probably rate-limit/transient errors — don't pin them to disk.
  if (resolved >= 2) {
    cache[spotifyUrl] = {
      fetchedAt: new Date().toISOString(),
      links,
    };
    cacheDirty = true;
  }

  return links;
}
