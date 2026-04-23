// Bandsintown API client.
// Pulled at build time from src/pages/shows.astro.
// API ref: https://app.swaggerhub.com/apis-docs/Bandsintown/PublicAPI/3.0.1

const ARTIST_ID = "15635129"; // Vibin' Psybin and the Sunlight Band
const API_BASE = "https://rest.bandsintown.com";

export interface BandsintownOffer {
  type: string;
  url: string;
  status: string;
}

export interface BandsintownVenue {
  name: string;
  city: string;
  region: string;
  country: string;
  latitude?: string;
  longitude?: string;
  street_address?: string;
  postal_code?: string;
  location?: string;
}

export interface BandsintownEvent {
  id: string;
  url: string;
  datetime: string;       // ISO, no timezone
  starts_at?: string;
  ends_at?: string;
  title?: string;
  description?: string;
  venue: BandsintownVenue;
  offers?: BandsintownOffer[];
  lineup?: string[];
  sold_out?: boolean;
}

export interface NormalizedShow {
  id: string;
  datetime: string;
  endsAt?: string;
  venue: string;
  city: string;
  ticketUrl?: string;
  soldOut: boolean;
  lineup: string[];
  bandsintownUrl: string;
  notes?: string;
}

const IMPORT_META_ENV =
  typeof import.meta !== "undefined" && import.meta.env
    ? (import.meta.env as Record<string, string | undefined>)
    : undefined;

function getAppId(): string {
  // Bandsintown calls their credential `app_id` in the API, but in their
  // dashboard it's labeled "API Key". Accept either name to avoid confusion.
  const envKeys = ["BANDSINTOWN_APP_ID", "BANDSINTOWN_API_KEY"];
  for (const k of envKeys) {
    const v = IMPORT_META_ENV?.[k] || (typeof process !== "undefined" ? process.env[k] : undefined);
    if (v) return v;
  }
  return "";
}

/**
 * Best-effort venue name cleanup. Bandsintown's `venue.name` field sometimes
 * mirrors the event title ("Artist with guests Foo and Bar") instead of the
 * actual venue name. This heuristic falls back to the street address or city
 * when the venue name looks event-shaped.
 */
function cleanVenue(ev: BandsintownEvent): string {
  const raw = ev.venue.name || "";
  const looksLikeEventTitle =
    raw.toLowerCase().includes("with special guest") ||
    raw.toLowerCase().includes(" with ") && raw.length > 60;
  if (looksLikeEventTitle) {
    // Prefer street address if available; else fall back to city.
    return ev.venue.street_address || ev.venue.location || ev.venue.city || raw;
  }
  return raw;
}

function normalize(ev: BandsintownEvent): NormalizedShow {
  const ticketOffer =
    ev.offers?.find((o) => o.type.toLowerCase().includes("ticket") && o.status === "available") ||
    ev.offers?.find((o) => o.type.toLowerCase().includes("ticket"));
  const locationParts = [ev.venue.city, ev.venue.region].filter(Boolean).join(", ");
  return {
    id: ev.id,
    datetime: ev.datetime,
    endsAt: ev.ends_at,
    venue: cleanVenue(ev),
    city: locationParts,
    ticketUrl: ticketOffer?.url,
    soldOut: Boolean(ev.sold_out),
    lineup: ev.lineup || [],
    bandsintownUrl: ev.url,
    notes: ev.title && ev.title !== ev.venue.name ? ev.title : undefined,
  };
}

export async function fetchShows(filter: "upcoming" | "past" | "all" = "all"): Promise<NormalizedShow[]> {
  const appId = getAppId();
  if (!appId) {
    console.warn("[bandsintown] No BANDSINTOWN_APP_ID set; falling back to empty list.");
    return [];
  }
  const url = `${API_BASE}/artists/id_${ARTIST_ID}/events?app_id=${appId}&date=${filter}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[bandsintown] ${res.status} ${res.statusText} for ${url}`);
      return [];
    }
    const data = (await res.json()) as BandsintownEvent[];
    return data.map(normalize).sort((a, b) => +new Date(a.datetime) - +new Date(b.datetime));
  } catch (e) {
    console.warn("[bandsintown] fetch failed:", e);
    return [];
  }
}
