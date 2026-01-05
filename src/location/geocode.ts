import { promises as fs } from "node:fs";
import path from "node:path";
import { fetch } from "undici";

type CachedGeocode = {
  place: string;
  at: string;
  latitude: number;
  longitude: number;
  displayName?: string;
  boundingBox?: [number, number, number, number];
};

type GeocodeCacheFile = {
  version: 1;
  entries: Record<string, CachedGeocode>;
};

const DEFAULT_CACHE_PATH = path.resolve(process.cwd(), "data", "geocode-cache.json");
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function cacheKey(place: string): string {
  return place.trim().toLowerCase();
}

async function readCache(cachePath: string): Promise<GeocodeCacheFile> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid cache format");
    const v = (parsed as any).version;
    const entries = (parsed as any).entries;
    if (v !== 1 || !entries || typeof entries !== "object") throw new Error("Invalid cache format");
    return parsed as GeocodeCacheFile;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as any).code === "ENOENT") {
      return { version: 1, entries: {} };
    }
    throw err;
  }
}

async function writeCache(cachePath: string, cache: GeocodeCacheFile): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

function parseBoundingBox(bb: unknown): [number, number, number, number] | undefined {
  // Nominatim returns [south, north, west, east] as strings.
  if (!Array.isArray(bb) || bb.length !== 4) return undefined;
  const nums = bb.map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000; // meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function nominatimSearch(q: string, limit: number): Promise<any[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=${encodeURIComponent(String(limit))}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "resybot-open/0.1.0 (local-cli)",
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Geocode failed: ${res.status} ${res.statusText}. Body: ${text.slice(0, 400)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Geocode response was not valid JSON. Body: ${text.slice(0, 400)}`);
  }
  return Array.isArray(data) ? data : [];
}

function geocodeAnchorFromPlace(place: string): string | undefined {
  // If the place has a neighborhood prefix like "SoHo, New York, NY",
  // using the tail ("New York, NY") as an anchor helps disambiguate cases
  // like "West Village" (Buffalo vs Manhattan).
  const parts = place
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) return undefined;
  const anchor = parts.slice(1).join(", ");
  return anchor && anchor.toLowerCase() !== place.toLowerCase() ? anchor : undefined;
}

export async function geocodePlace(input: {
  place: string;
  cachePath?: string;
  ttlMs?: number;
  force?: boolean;
}): Promise<CachedGeocode> {
  const place = input.place.trim();
  if (!place) throw new Error("place is required");

  const cachePath = input.cachePath ? path.resolve(input.cachePath) : DEFAULT_CACHE_PATH;
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const key = cacheKey(place);

  const cache = await readCache(cachePath);
  const existing = cache.entries[key];
  if (!input.force && existing) {
    const at = new Date(existing.at).getTime();
    if (Number.isFinite(at) && Date.now() - at <= ttlMs) {
      // If the input looks like "Neighborhood, City, State", sanity-check the cached point
      // by ensuring it's not extremely far from the geocoded city/state anchor.
      const anchor = geocodeAnchorFromPlace(place);
      if (anchor) {
        try {
          const anchorRows = await nominatimSearch(anchor, 1);
          const anchorLat = anchorRows.length ? Number(anchorRows[0]?.lat) : undefined;
          const anchorLon = anchorRows.length ? Number(anchorRows[0]?.lon) : undefined;
          if (
            anchorLat !== undefined &&
            anchorLon !== undefined &&
            Number.isFinite(anchorLat) &&
            Number.isFinite(anchorLon)
          ) {
            const dist = haversineMeters(
              { lat: existing.latitude, lon: existing.longitude },
              { lat: anchorLat, lon: anchorLon },
            );
            // If it's wildly far from the anchor (e.g., West Village Buffalo vs NYC),
            // ignore cache and re-geocode.
            if (dist <= 100_000) return existing; // 100km
          } else {
            return existing;
          }
        } catch {
          return existing;
        }
      } else {
        return existing;
      }
    }
  }

  const candidates = await nominatimSearch(place, 5);
  if (candidates.length === 0) throw new Error(`No geocode results for "${place}"`);

  // If ambiguous, pick the candidate closest to an anchor derived from the tail of the place string.
  let row = candidates[0];
  const anchor = geocodeAnchorFromPlace(place);
  if (anchor && candidates.length > 1) {
    const anchorRows = await nominatimSearch(anchor, 1);
    const anchorLat = anchorRows.length ? Number(anchorRows[0]?.lat) : undefined;
    const anchorLon = anchorRows.length ? Number(anchorRows[0]?.lon) : undefined;
    if (anchorLat !== undefined && anchorLon !== undefined && Number.isFinite(anchorLat) && Number.isFinite(anchorLon)) {
      let bestIdx = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const lat = Number(c?.lat);
        const lon = Number(c?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const dist = haversineMeters({ lat, lon }, { lat: anchorLat, lon: anchorLon });
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      row = candidates[bestIdx] ?? row;
    }
  }

  const lat = Number(row?.lat);
  const lon = Number(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`Geocode result missing lat/lon for "${place}"`);

  const bb = parseBoundingBox(row?.boundingbox);

  const next: CachedGeocode = {
    place,
    at: new Date().toISOString(),
    latitude: lat,
    longitude: lon,
    ...(typeof row?.display_name === "string" ? { displayName: row.display_name } : {}),
    ...(bb ? { boundingBox: bb } : {}),
  };

  cache.entries[key] = next;
  await writeCache(cachePath, cache);
  return next;
}

export function locationKeyFromPlace(place: string): string {
  // Stable-ish, filesystem-friendly key.
  const slug = place
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
  return slug || "location";
}


