import { promises as fs } from "node:fs";
import path from "node:path";

type LocationProfile = {
  place: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  timezone: string;
  resyLocationSlug: string;
  minRating: number;
  minRatingCount?: number;
  query?: string;
  neighborhoodContains?: string;
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
  leadTimeInDays?: number;
  releaseTimeLocal?: string;
  bookingWindowMaxDate?: string;
  bookingWindowDaysEstimate?: number;
  inventoryDatesCount?: number;
  meta?: any;
};

function safe(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export async function writeLocationReport(input: {
  locationDir: string;
  outFile?: string;
}): Promise<{ outFile: string; venues: number; enabled: number; exactReleaseTimes: number }> {
  const dir = path.resolve(input.locationDir);
  const locationPath = path.join(dir, "location.json");
  const venuesPath = path.join(dir, "venues.json");
  const outPath = path.resolve(input.outFile ?? path.join(dir, "venues.report.md"));

  const locRaw = await fs.readFile(locationPath, "utf8");
  const venuesRaw = await fs.readFile(venuesPath, "utf8");
  const profile = JSON.parse(locRaw) as LocationProfile;
  const venues = JSON.parse(venuesRaw) as VenueRow[];
  if (!Array.isArray(venues)) throw new Error(`Expected venues.json to be an array: ${venuesPath}`);

  const enabledCount = venues.filter((v) => v.enabled).length;
  const exactCount = venues.filter((v) => typeof v.releaseTimeLocal === "string" && v.releaseTimeLocal.length > 0).length;

  const lines: string[] = [];
  lines.push(`# Resy venues: ${profile.place}`);
  lines.push("");
  lines.push(`- Generated: \`${profile.generatedAt}\``);
  lines.push(`- Coords: \`${profile.latitude}, ${profile.longitude}\``);
  lines.push(`- Radius: \`${profile.radiusMeters}m\``);
  lines.push(`- Timezone: \`${profile.timezone}\``);
  lines.push(`- Resy location slug: \`${profile.resyLocationSlug}\``);
  lines.push(`- Filters: minRating=${profile.minRating}, minRatingCount=${profile.minRatingCount ?? "none"}`);
  if (profile.query) lines.push(`- Query: \`${profile.query}\``);
  if (profile.neighborhoodContains) lines.push(`- Neighborhood contains: \`${profile.neighborhoodContains}\``);
  lines.push(`- Venues: **${venues.length}**, enabled: **${enabledCount}**, exact release time found: **${exactCount}**`);
  lines.push("");

  lines.push("| enabled | name | rating | ratings | leadTimeDays | releaseTime | neighborhood | id | resy |");
  lines.push("|---:|---|---:|---:|---:|---:|---|---:|---|");

  const sorted = venues.slice().sort((a, b) => {
    const ea = a.enabled ? 1 : 0;
    const eb = b.enabled ? 1 : 0;
    if (eb !== ea) return eb - ea;
    const ra = a.ratingAverage ?? 0;
    const rb = b.ratingAverage ?? 0;
    if (rb !== ra) return rb - ra;
    const ca = a.ratingCount ?? 0;
    const cb = b.ratingCount ?? 0;
    if (cb !== ca) return cb - ca;
    return a.name.localeCompare(b.name);
  });

  for (const v of sorted) {
    const enabled = v.enabled ? "1" : "0";
    const resyUrl =
      v.urlSlug && profile.resyLocationSlug
        ? `https://resy.com/cities/${encodeURIComponent(profile.resyLocationSlug)}/venues/${encodeURIComponent(v.urlSlug)}`
        : "";
    const nameCell = resyUrl ? `[${safe(v.name)}](${resyUrl})` : safe(v.name);
    lines.push(
      `| ${enabled} | ${nameCell} | ${safe(v.ratingAverage ?? "")} | ${safe(v.ratingCount ?? "")} | ${safe(v.leadTimeInDays ?? "")} | ${safe(
        v.releaseTimeLocal ?? "",
      )} | ${safe(v.neighborhood ?? "")} | ${safe(v.id)} | ${safe(v.urlSlug ?? "")} |`,
    );
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n") + "\n", "utf8");
  return { outFile: outPath, venues: venues.length, enabled: enabledCount, exactReleaseTimes: exactCount };
}


