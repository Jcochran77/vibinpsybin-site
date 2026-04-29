// Spotify Web API client.
// Pulled at build time from src/pages/music.astro and src/pages/index.astro.
//
// Uses the Client Credentials flow (no user auth) — perfect for build-time scrapes.
// Docs: https://developer.spotify.com/documentation/web-api
//
// Requires env vars:
//   SPOTIFY_CLIENT_ID
//   SPOTIFY_CLIENT_SECRET
//
// Fail-safe: if credentials are missing OR any API call fails, this module
// falls back to the static list in src/data/releases.json so the site still
// builds cleanly. Releases.json is kept as the fallback source of truth —
// do NOT delete it until the Spotify path has been green in prod for a
// couple of deploys.

import fallbackReleases from "../data/releases.json";
import releaseOverrides from "../data/release-overrides.json";
import {
  fetchPlatformLinks,
  getCachedPlatformLinks,
  flushPlatformLinkCache,
  emptyPlatformLinks,
  sleep,
  type PlatformLinks,
} from "./songlink";
import { fillAppleMusicGaps } from "./itunes";

// Artist IDs confirmed by Joe.
const ARTIST_IDS: { id: string; displayName: string }[] = [
  { id: "40SRpqCKiQZZ3alrYeXAYR", displayName: "Psybin" },
  { id: "16AgfIKYaZe0mmiAHuzVta", displayName: "Vibin' Psybin and the Sunlight Band" },
];

// Pre-album / pre-EP singles whose tracks were later included on a larger
// release. Hidden from /music to keep the discography page clean — listeners
// see the canonical (largest) release for any given track. The single still
// exists on streaming services, just not surfaced on our site.
//
// To un-hide a release, remove its ID from this list.
// To hide a new release, add the Spotify album ID with a comment explaining
// which larger release supersedes it.
const HIDDEN_ALBUM_IDS: ReadonlySet<string> = new Set([
  "74CfTR822eh6VGiJyccNct", // Live Fast/Headlights (2022-08-19) — rolled into Live Fast EP
  "2umhMZ61vkt96y2yD1dsaA", // A Million Miles/Love Song #2 (2022-10-17) — rolled into Live Fast EP
  "24fIqXw9dOn6P2zEBFskbV", // Do No Wrong / I Know A Girl (2023-07-28) — rolled into Hippie Cowboy
  "7snksh4HsQhprvFB8cPi9s", // King of Tennessee (2024-01-12) — rolled into Hippie Cowboy
  "5eocqaLyIyfEsou3RR3S1e", // Good Time Girls (2024-04-12) — rolled into Hippie Cowboy
  "5HmfzolN3eqSUB9wLodgFb", // Because You Said So (2024-05-24) — rolled into Hippie Cowboy
  "2cSlJc8Fz5zdIY0Im5rDjo", // Songbird (2024-07-19) — rolled into Hippie Cowboy
  "7zlkcsMJBLcCx97tPRr8YW", // Po-Dunk Baby (2025-05-23) — rolled into To The Wind
  "4pcZ5EAZ3jqgMzsf0rRXjX", // Let Me Loose (2025-06-27) — rolled into To The Wind
]);

const API_BASE = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const MARKET = "US";

export type ReleaseType = "album" | "single" | "ep" | "compilation";

export interface NormalizedRelease {
  id: string;
  title: string;
  artist: string;
  year: number;
  type: ReleaseType;
  coverUrl: string | null;
  spotifyUrl: string | null;
  trackNames: string[];
  releaseDate: string; // YYYY-MM-DD or YYYY-MM or YYYY (Spotify varies by precision)
  notes?: string;
  /**
   * Resolved streaming-platform URLs from Odesli/song.link. May be null when
   * the request failed (Odesli down, timeout, etc.) — UI must fall back to
   * just the Spotify button in that case.
   */
  platformLinks: PlatformLinks | null;
  /**
   * Bandcamp URL pulled from src/data/release-overrides.json. Optional; null
   * when the release isn't on Bandcamp yet (Joe is still uploading the
   * catalog).
   */
  bandcampUrl: string | null;
}

// --- Per-release overrides (Bandcamp etc.) ---

interface ReleaseOverrideEntry {
  bandcampUrl?: string;
}

function getOverride(albumId: string): ReleaseOverrideEntry | null {
  // The JSON file may include a leading `_comment` field for documentation.
  // Skip non-object values defensively.
  const raw = (releaseOverrides as Record<string, unknown>)[albumId];
  if (!raw || typeof raw !== "object") return null;
  return raw as ReleaseOverrideEntry;
}

// --- Spotify response types (partial) ---

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyArtistRef {
  id: string;
  name: string;
}

interface SpotifyAlbum {
  id: string;
  name: string;
  album_type: string; // "album" | "single" | "compilation"
  album_group?: string; // "album" | "single" | "compilation" | "appears_on"
  release_date: string;
  release_date_precision: "day" | "month" | "year";
  images: SpotifyImage[];
  external_urls: { spotify?: string };
  artists: SpotifyArtistRef[];
  total_tracks: number;
}

interface SpotifyAlbumsResponse {
  items: SpotifyAlbum[];
  next: string | null;
}

interface SpotifyTrack {
  id: string;
  name: string;
  track_number: number;
  disc_number: number;
}

interface SpotifyTracksResponse {
  items: SpotifyTrack[];
  next: string | null;
}

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

// --- Env helpers ---

const IMPORT_META_ENV =
  typeof import.meta !== "undefined" && import.meta.env
    ? (import.meta.env as Record<string, string | undefined>)
    : undefined;

function envVar(name: string): string | undefined {
  return (
    IMPORT_META_ENV?.[name] ||
    (typeof process !== "undefined" ? process.env[name] : undefined)
  );
}

function getCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = envVar("SPOTIFY_CLIENT_ID");
  const clientSecret = envVar("SPOTIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// --- Token caching (module-scoped; lives only for the duration of the build) ---

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.token;
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[spotify] token fetch failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  const data = (await res.json()) as SpotifyTokenResponse;
  cachedToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return data.access_token;
}

// --- API fetchers ---

async function spotifyGet<T>(
  path: string,
  token: string,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[spotify] GET ${url} -> ${res.status} ${res.statusText} ${text}`,
    );
  }
  return (await res.json()) as T;
}

async function fetchArtistAlbums(
  artistId: string,
  displayName: string,
  token: string,
): Promise<SpotifyAlbum[]> {
  // Don't use URLSearchParams here: Spotify rejects URL-encoded commas in
  // include_groups (%2C). Build the query string manually with a raw comma.
  // Spotify now caps limit at 10 for new/unverified apps (used to be 50).
  // Pagination handles the rest via page.next.
  let url: string | null =
    `/artists/${artistId}/albums?include_groups=album,single&limit=10&market=${encodeURIComponent(MARKET)}`;
  const out: SpotifyAlbum[] = [];
  // Paginate just in case — usually one page is plenty.
  while (url) {
    const page = await spotifyGet<SpotifyAlbumsResponse>(url, token);
    for (const a of page.items) {
      // Only keep releases where this artist is actually the primary artist.
      // (Spotify sometimes returns "appears_on" releases — we filter those
      // via include_groups, but also double-check the artists array.)
      if (a.artists.some((ar) => ar.id === artistId)) {
        out.push(a);
      }
    }
    url = page.next;
  }
  // Tag the artist display name onto a side map by mutating a synthetic prop.
  // Simpler: let the caller pass the displayName alongside.
  void displayName;
  return out;
}

async function fetchAlbumTracks(
  albumId: string,
  token: string,
): Promise<string[]> {
  // Same limit-10 cap as albums endpoint.
  let url: string | null =
    `/albums/${albumId}/tracks?limit=10&market=${encodeURIComponent(MARKET)}`;
  const names: { name: string; track: number; disc: number }[] = [];
  while (url) {
    const page = await spotifyGet<SpotifyTracksResponse>(url, token);
    for (const t of page.items) {
      names.push({ name: t.name, track: t.track_number, disc: t.disc_number });
    }
    url = page.next;
  }
  names.sort((a, b) =>
    a.disc === b.disc ? a.track - b.track : a.disc - b.disc,
  );
  return names.map((n) => n.name);
}

// --- Normalization ---

function pickLargestImage(images: SpotifyImage[]): string | null {
  if (!images || images.length === 0) return null;
  // Spotify returns images sorted largest-first, but be defensive.
  const sorted = [...images].sort(
    (a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
  );
  return sorted[0]?.url ?? null;
}

function parseYear(releaseDate: string): number {
  const y = parseInt(releaseDate.slice(0, 4), 10);
  return Number.isFinite(y) ? y : 0;
}

function classifyType(album: SpotifyAlbum): ReleaseType {
  const t = (album.album_type || "").toLowerCase();
  // Spotify has no "ep" album_type. Treat short "album" releases as EPs when
  // they're <= 6 tracks AND titled with "EP", OR use a conservative heuristic.
  const name = album.name.toLowerCase();
  if (name.includes(" ep") || name.endsWith(" ep") || name.includes("(ep)")) {
    return "ep";
  }
  if (t === "album" && album.total_tracks > 0 && album.total_tracks <= 6) {
    // Could be an EP; but without an explicit title marker, keep as album.
    return "album";
  }
  if (t === "compilation") return "compilation";
  if (t === "single") return "single";
  if (t === "album") return "album";
  return "single";
}

function normalize(
  album: SpotifyAlbum,
  artistDisplayName: string,
  trackNames: string[],
): NormalizedRelease {
  const override = getOverride(album.id);
  return {
    id: album.id,
    title: album.name,
    artist: artistDisplayName,
    year: parseYear(album.release_date),
    type: classifyType(album),
    coverUrl: pickLargestImage(album.images),
    spotifyUrl: album.external_urls?.spotify ?? null,
    trackNames,
    releaseDate: album.release_date,
    platformLinks: null, // populated after-the-fact in fetchSpotifyReleases
    bandcampUrl: override?.bandcampUrl ?? null,
  };
}

// --- Fallback ---

interface FallbackReleaseShape {
  id: string;
  title: string;
  artist: string;
  year: number;
  type: string;
  tracks?: string[];
  notes?: string;
}

function fallbackToNormalized(): NormalizedRelease[] {
  const list = fallbackReleases as FallbackReleaseShape[];
  return list.map((r) => {
    const override = getOverride(r.id);
    return {
      id: r.id,
      title: r.title,
      artist: r.artist,
      year: r.year,
      type: (["album", "single", "ep", "compilation"].includes(r.type)
        ? r.type
        : "single") as ReleaseType,
      coverUrl: null,
      spotifyUrl: null,
      trackNames: r.tracks ?? [],
      releaseDate: `${r.year}-01-01`,
      notes: r.notes,
      platformLinks: null,
      bandcampUrl: override?.bandcampUrl ?? null,
    };
  });
}

// --- Dedupe & sort ---

/**
 * Same release sometimes shows up on both artist profiles (the band release
 * lists "Psybin" as a featured artist, etc). Dedupe by Spotify album id first,
 * then by a normalized (title + year) fallback.
 */
function dedupe(releases: NormalizedRelease[]): NormalizedRelease[] {
  const byId = new Map<string, NormalizedRelease>();
  const byKey = new Map<string, NormalizedRelease>();
  for (const r of releases) {
    if (byId.has(r.id)) continue;
    const key = `${r.title.toLowerCase().trim()}::${r.year}`;
    const existing = byKey.get(key);
    if (existing) {
      // Prefer whichever has richer track data; otherwise keep existing.
      if (r.trackNames.length > existing.trackNames.length) {
        byId.delete(existing.id);
        byKey.set(key, r);
        byId.set(r.id, r);
      }
      continue;
    }
    byKey.set(key, r);
    byId.set(r.id, r);
  }
  return Array.from(byId.values());
}

function sortNewestFirst(releases: NormalizedRelease[]): NormalizedRelease[] {
  return [...releases].sort((a, b) => {
    const ad = a.releaseDate;
    const bd = b.releaseDate;
    if (ad === bd) return 0;
    return ad < bd ? 1 : -1;
  });
}

// --- Public API ---

// Module-scoped cache (lives only for the duration of one build). Astro
// renders music.astro and index.astro independently, but in the same Node
// process — cache the in-flight Promise so we don't double-fetch (and
// double-rate-limit) Odesli.
let cachedReleasesPromise: Promise<NormalizedRelease[]> | null = null;

/**
 * Fetch normalized releases from Spotify for both artist profiles, merge,
 * dedupe, and sort newest-first. Falls back to the static releases.json if
 * credentials are missing or any API call fails.
 *
 * Build-time cached — safe to call from multiple pages.
 */
export async function fetchSpotifyReleases(): Promise<NormalizedRelease[]> {
  if (cachedReleasesPromise) return cachedReleasesPromise;
  cachedReleasesPromise = fetchSpotifyReleasesUncached();
  return cachedReleasesPromise;
}

async function fetchSpotifyReleasesUncached(): Promise<NormalizedRelease[]> {
  const creds = getCredentials();
  if (!creds) {
    console.warn(
      "[spotify] SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set; falling back to src/data/releases.json",
    );
    return sortNewestFirst(fallbackToNormalized());
  }

  try {
    const token = await getAccessToken(creds.clientId, creds.clientSecret);

    const albumLists = await Promise.all(
      ARTIST_IDS.map(async ({ id, displayName }) => {
        const albums = await fetchArtistAlbums(id, displayName, token);
        return albums.map((a) => ({ album: a, displayName }));
      }),
    );

    const flat = albumLists.flat();

    // Fetch tracks per album, throttled gently (sequential per-artist but
    // parallel across artists is fine — we already have all albums).
    const withTracks = await Promise.all(
      flat.map(async ({ album, displayName }) => {
        let trackNames: string[] = [];
        try {
          trackNames = await fetchAlbumTracks(album.id, token);
        } catch (e) {
          console.warn(
            `[spotify] track fetch failed for album ${album.id} (${album.name}):`,
            e,
          );
        }
        return normalize(album, displayName, trackNames);
      }),
    );

    const deduped = dedupe(withTracks);

    // Hide pre-album / pre-EP singles whose tracks are already on a larger
    // release (see HIDDEN_ALBUM_IDS at the top of this file). Logged for
    // build-time visibility so we know what got filtered.
    const visible = deduped.filter((r) => {
      if (HIDDEN_ALBUM_IDS.has(r.id)) {
        console.log(`[spotify] hiding pre-release single from /music: ${r.title} (${r.id})`);
        return false;
      }
      return true;
    });

    const sorted = sortNewestFirst(visible);
    if (sorted.length === 0) {
      console.warn(
        "[spotify] returned zero releases after dedupe; falling back to releases.json",
      );
      return sortNewestFirst(fallbackToNormalized());
    }

    // Resolve cross-platform links via Odesli. Odesli unverified rate-limit
    // is 10 req/min — we throttle at 7s/request to stay safely under and
    // leave headroom for retries on 429.
    //
    // Set SKIP_ODESLI=1 to bypass entirely (e.g. when the cache is already
    // warm and you want a fast local build, or when Odesli is down).
    const skipOdesli = envVar("SKIP_ODESLI") === "1";
    if (skipOdesli) {
      console.log(
        `[spotify] SKIP_ODESLI=1 set; using cache-only — platform links will be empty for any uncached release`,
      );
    }
    const ODESLI_THROTTLE_MS = 7_000;
    console.log(
      `[spotify] resolving cross-platform links for ${sorted.length} releases via Odesli (${ODESLI_THROTTLE_MS / 1000}s throttle) ...`,
    );
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      if (!r.spotifyUrl) {
        r.platformLinks = emptyPlatformLinks();
        continue;
      }
      if (skipOdesli) {
        // Cache-only mode: read previously-fetched data, skip the network.
        r.platformLinks = getCachedPlatformLinks(r.spotifyUrl) ?? emptyPlatformLinks();
        continue;
      }
      const before = Date.now();
      r.platformLinks = await fetchPlatformLinks(r.spotifyUrl, r.title);
      const elapsed = Date.now() - before;
      // Only throttle when we actually hit the network. Cache hits return
      // in <5ms — no need to sleep, build stays fast.
      if (i < sorted.length - 1 && elapsed > 100) {
        await sleep(ODESLI_THROTTLE_MS);
      }
    }
    flushPlatformLinkCache();
    console.log(`[spotify] cross-platform link resolution complete`);

    // iTunes Search fallback: Odesli is unreliable for Apple Music matches
    // on Joe's catalog (returns null even though every release IS on Apple
    // Music). Fill any remaining gaps directly from iTunes Search API.
    // Only mutates `appleMusic` slots that came back null from Odesli —
    // existing data is never overridden.
    try {
      await fillAppleMusicGaps(sorted);
    } catch (e) {
      console.warn(
        "[itunes] fallback resolver threw; continuing without iTunes fills:",
        e instanceof Error ? e.message : e,
      );
    }

    return sorted;
  } catch (e) {
    console.warn(
      "[spotify] fetch failed; falling back to releases.json:",
      e instanceof Error ? e.message : e,
    );
    return sortNewestFirst(fallbackToNormalized());
  }
}
