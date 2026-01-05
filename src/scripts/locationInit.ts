import { promises as fs } from "node:fs";
import path from "node:path";
import { geocodePlace, locationKeyFromPlace } from "../location/geocode";
import { timezoneForCoordinates } from "../location/timezone";
import { resolveNearestResyLocation } from "../location/resyLocation";
import { discoverTopRatedVenues } from "./discoverTopRatedVenues";
import { enrichVenuesMetadata } from "./enrichVenuesMetadata";
import { writeLocationReport } from "./locationReport";

export type LocationProfile = {
  place: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  timezone: string; // IANA
  resyLocationSlug: string; // for /3/venue + resy.com URLs
  resyNearestLocation?: {
    name?: string;
    urlSlug: string;
    code?: string;
    timeZone?: string;
    distanceMeters: number;
  };
  minRating: number;
  minRatingCount?: number;
  query?: string;
  neighborhoodContains?: string;
  partySize: number;
  day: string;
  generatedAt: string;
};

type VenueRow = Record<string, unknown> & {
  id: number | string;
  urlSlug?: string;
  name: string;
  neighborhood?: string;
  ratingAverage?: number;
  ratingCount?: number;
  enabled?: boolean;
};

function todayLocalYYYYMMDD(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function locationInit(input: {
  place: string;
  baseDir?: string;
  locationKey?: string;
  radiusMeters?: number;
  minRating?: number;
  minRatingCount?: number;
  query?: string;
  neighborhoodContains?: string;
  partySize?: number;
  day?: string;
  autoEnableTop?: number;
  enrichDelayMs?: number;
  skipEnrich?: boolean;
  forceGeocode?: boolean;
}): Promise<{ locationDir: string; locationKey: string; venuesFile: string; reportFile: string; venues: number }> {
  const place = input.place.trim();
  if (!place) throw new Error("--place is required");

  const baseDir = path.resolve(input.baseDir ?? "data/locations");
  const locationKey = input.locationKey?.trim() ? input.locationKey.trim() : locationKeyFromPlace(place);
  const locationDir = path.join(baseDir, locationKey);

  const geo = await geocodePlace({ place, force: Boolean(input.forceGeocode) });
  const timezone = timezoneForCoordinates(geo.latitude, geo.longitude);
  const resyLoc = await resolveNearestResyLocation({ latitude: geo.latitude, longitude: geo.longitude });

  const radiusMeters = input.radiusMeters ?? 2000;
  const minRating = input.minRating ?? 4.5;
  const minRatingCount = input.minRatingCount;
  const partySize = input.partySize ?? 2;
  const day = input.day ?? todayLocalYYYYMMDD();
  const query = input.query ?? "";
  const neighborhoodContains = input.neighborhoodContains?.trim() ? input.neighborhoodContains.trim() : undefined;
  const autoEnableTop = input.autoEnableTop ?? 15;
  const enrichDelayMs = input.enrichDelayMs ?? 650;

  const discovered = await discoverTopRatedVenues({
    latitude: geo.latitude,
    longitude: geo.longitude,
    radiusMeters,
    day,
    partySize,
    minRating,
    ...(minRatingCount !== undefined ? { minRatingCount } : {}),
    ...(query.trim().length ? { query: query.trim() } : {}),
    ...(neighborhoodContains ? { neighborhoodContains } : {}),
    orderBy: "distance",
    availability: false,
  });

  // Sort by rating desc, then count desc, then name
  discovered.sort((a, b) => {
    const ra = a.ratingAverage ?? 0;
    const rb = b.ratingAverage ?? 0;
    if (rb !== ra) return rb - ra;
    const ca = a.ratingCount ?? 0;
    const cb = b.ratingCount ?? 0;
    if (cb !== ca) return cb - ca;
    return a.name.localeCompare(b.name);
  });

  const venues: VenueRow[] = discovered.map((v, idx) => ({
    ...v,
    enabled: idx < autoEnableTop,
  }));

  const profile: LocationProfile = {
    place,
    latitude: geo.latitude,
    longitude: geo.longitude,
    radiusMeters,
    timezone,
    resyLocationSlug: resyLoc.urlSlug,
    resyNearestLocation: {
      urlSlug: resyLoc.urlSlug,
      ...(resyLoc.name ? { name: resyLoc.name } : {}),
      ...(resyLoc.code ? { code: resyLoc.code } : {}),
      ...(resyLoc.timeZone ? { timeZone: resyLoc.timeZone } : {}),
      distanceMeters: resyLoc.distanceMeters,
    },
    minRating,
    ...(minRatingCount !== undefined ? { minRatingCount } : {}),
    ...(query.trim().length ? { query: query.trim() } : {}),
    ...(neighborhoodContains ? { neighborhoodContains } : {}),
    partySize,
    day,
    generatedAt: new Date().toISOString(),
  };

  const locationJsonPath = path.join(locationDir, "location.json");
  const venuesPath = path.join(locationDir, "venues.json");
  const reportPath = path.join(locationDir, "venues.report.md");

  await fs.mkdir(locationDir, { recursive: true });
  await writeJson(locationJsonPath, profile);
  await writeJson(venuesPath, venues);

  if (!input.skipEnrich) {
    await enrichVenuesMetadata({
      venuesFile: venuesPath,
      locationSlug: profile.resyLocationSlug,
      timezone: profile.timezone,
      cacheDir: path.join("data/venue-meta", locationKey),
      writeRaw: true,
      start: 0,
      limit: venues.length,
      delayMs: enrichDelayMs,
      force: true,
    });
  }

  await writeLocationReport({ locationDir, outFile: reportPath });

  return { locationDir, locationKey, venuesFile: venuesPath, reportFile: reportPath, venues: venues.length };
}


