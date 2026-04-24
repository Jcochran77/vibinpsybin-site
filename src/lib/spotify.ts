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

// Artist IDs confirmed by Joe.
const ARTIST_IDS: { id: string; displayName: string }[] = [
  { id: "40SRpqCKiQZZ3alrYeXAYR", displayName: "Psybin" },
  { id: "16AgfIKYaZe0mmiAHuzVta", displayName: "Vibin' Psybin and the Sunlight Band" },
];

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
  const qs = new URLSearchParams({
    include_groups: "album,single",
    limit: "50",
    market: MARKET,
  });
  let url: string | null = `/artists/${artistId}/albums?${qs.toString()}`;
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
  const qs = new URLSearchParams({ limit: "50", market: MARKET });
  let url: string | null = `/albums/${albumId}/tracks?${qs.toString()}`;
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
  return list.map((r) => ({
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
  }));
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

/**
 * Fetch normalized releases from Spotify for both artist profiles, merge,
 * dedupe, and sort newest-first. Falls back to the static releases.json if
 * credentials are missing or any API call fails.
 */
export async function fetchSpotifyReleases(): Promise<NormalizedRelease[]> {
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
    const sorted = sortNewestFirst(deduped);
    if (sorted.length === 0) {
      console.warn(
        "[spotify] returned zero releases after dedupe; falling back to releases.json",
      );
      return sortNewestFirst(fallbackToNormalized());
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
