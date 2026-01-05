import { promises as fs } from "node:fs";
import path from "node:path";
import { discoverTopRatedVenues, type DiscoveredVenueRow } from "./discoverTopRatedVenues";

type WestVillageTopRatedOptions = {
  minRating: number;
  radiusMeters: number;
  day: string;
  partySize: number;
  outFile?: string;
  outJsonFile?: string;
};

type VenueRow = {
  id: number | string;
  urlSlug?: string;
  name: string;
  neighborhood?: string;
  ratingAverage?: number;
  ratingCount?: number;
  bookingWindowMaxDate?: string;
  bookingWindowDaysEstimate?: number;
  inventoryDatesCount?: number;
  releasePolicyDaysInAdvance?: number;
  releasePolicyTime?: string;
  releasePolicySnippet?: string;
};

function todayLocalYYYYMMDD(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function defaultWestVillageTopRatedOptions(): WestVillageTopRatedOptions {
  return {
    minRating: 4.5,
    radiusMeters: 2000,
    day: todayLocalYYYYMMDD(),
    partySize: 2,
  };
}

export async function runWestVillageTopRated(opts: WestVillageTopRatedOptions): Promise<VenueRow[]> {
  // West Village-ish center
  const latitude = 40.7336;
  const longitude = -74.0031;

  const discovered = await discoverTopRatedVenues({
    latitude,
    longitude,
    radiusMeters: opts.radiusMeters,
    day: opts.day,
    partySize: opts.partySize,
    minRating: opts.minRating,
    query: "West Village",
    orderBy: "distance",
    availability: false,
    neighborhoodContains: "west village",
  });

  const rows: VenueRow[] = discovered.map((r: DiscoveredVenueRow) => r as VenueRow);
  rows.sort((a, b) => {
    const ra = a.ratingAverage ?? 0;
    const rb = b.ratingAverage ?? 0;
    if (rb !== ra) return rb - ra;
    const ca = a.ratingCount ?? 0;
    const cb = b.ratingCount ?? 0;
    if (cb !== ca) return cb - ca;
    return a.name.localeCompare(b.name);
  });

  if (opts.outFile) {
    const outPath = path.resolve(opts.outFile);
    await fs.writeFile(outPath, rows.map((r) => r.name).join("\n") + "\n", "utf8");
  }

  if (opts.outJsonFile) {
    const outPath = path.resolve(opts.outJsonFile);
    await fs.writeFile(outPath, JSON.stringify(rows, null, 2) + "\n", "utf8");
  }

  return rows;
}


