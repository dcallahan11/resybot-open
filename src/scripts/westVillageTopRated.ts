import { promises as fs } from "node:fs";
import path from "node:path";
import { ResyClient } from "../resy/resyClient";

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
  const resy = new ResyClient();

  // West Village-ish center
  const latitude = 40.7336;
  const longitude = -74.0031;

  const referenceDay = opts.day;

  const perPage = 50;
  const maxPages = 10;

  const byId = new Map<string, VenueRow>();

  const parseDateOnlyUTC = (yyyyMmDd: string): number | undefined => {
    const m = yyyyMmDd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return undefined;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const t = Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
    return Number.isFinite(t) ? t : undefined;
  };

  const extractReleasePolicyFromText = (
    text: string,
  ):
    | Pick<VenueRow, "releasePolicyDaysInAdvance" | "releasePolicyTime" | "releasePolicySnippet">
    | undefined => {
    const lower = text.toLowerCase();
    if (!lower.includes("reserv")) return undefined;

    // Look for phrases like:
    // - "Reservations are released 30 days in advance at 10am"
    // - "Reservations open 21 days out at 9:00 AM"
    // - "Reservations release daily at 10am, 30 days in advance"
    const daysMatch =
      lower.match(/(\d{1,2})\s*(?:day|days)\s*(?:in\s*advance|ahead|out)\b/) ??
      lower.match(/(\d{1,2})\s*(?:day|days)\s*(?:prior|before)\b/);
    const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);

    const days = daysMatch ? Number(daysMatch[1]) : undefined;
    let time: string | undefined;
    if (timeMatch) {
      let hour = Number(timeMatch[1]);
      const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
      const ampm = timeMatch[3];
      if (ampm === "pm" && hour !== 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      }
    }

    if (days === undefined && time === undefined) return undefined;

    // Keep snippet short for readability
    const snippet = text.length > 260 ? `${text.slice(0, 260)}…` : text;
    return {
      ...(days !== undefined ? { releasePolicyDaysInAdvance: days } : {}),
      ...(time !== undefined ? { releasePolicyTime: time } : {}),
      releasePolicySnippet: snippet,
    } as Pick<VenueRow, "releasePolicyDaysInAdvance" | "releasePolicyTime" | "releasePolicySnippet">;
  };

  for (let page = 1; page <= maxPages; page++) {
    const resp = await resy.venueSearch({
      day: opts.day,
      partySize: opts.partySize,
      page,
      perPage,
      latitude,
      longitude,
      radiusMeters: opts.radiusMeters,
      query: "West Village",
      orderBy: "distance",
      availability: false,
    });

    const hits: any[] = Array.isArray(resp?.search?.hits) ? resp.search.hits : [];
    if (hits.length === 0) break;

    for (const hit of hits) {
      const name = typeof hit?.name === "string" ? hit.name : undefined;
      if (!name) continue;

      const neighborhood = typeof hit?.neighborhood === "string" ? hit.neighborhood : undefined;
      if (!neighborhood || !neighborhood.toLowerCase().includes("west village")) continue;

      const avg = typeof hit?.rating?.average === "number" ? hit.rating.average : undefined;
      const count = typeof hit?.rating?.count === "number" ? hit.rating.count : undefined;
      if (avg === undefined || avg <= opts.minRating) continue;

      const invDatesRaw: unknown = hit?.inventory_reservation;
      const invDates = Array.isArray(invDatesRaw)
        ? (invDatesRaw.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) as string[])
        : [];
      const bookingWindowMaxDate = invDates.length ? invDates.slice().sort().at(-1) : undefined;
      const refTs = parseDateOnlyUTC(referenceDay);
      const maxTs = bookingWindowMaxDate ? parseDateOnlyUTC(bookingWindowMaxDate) : undefined;
      const bookingWindowDaysEstimate =
        refTs !== undefined && maxTs !== undefined ? Math.round((maxTs - refTs) / 86_400_000) : undefined;

      // Try to extract release policy from any textual fields we can find.
      let releasePolicy:
        | Pick<VenueRow, "releasePolicyDaysInAdvance" | "releasePolicyTime" | "releasePolicySnippet">
        | undefined;

      if (Array.isArray(hit?.content)) {
        for (const c of hit.content) {
          if (releasePolicy) break;
          const body = typeof c?.body === "string" ? c.body : undefined;
          if (!body) continue;
          const extracted = extractReleasePolicyFromText(body);
          if (extracted) releasePolicy = extracted;
        }
      }

      if (!releasePolicy && hit?.availability?.templates && typeof hit.availability.templates === "object") {
        for (const tpl of Object.values(hit.availability.templates)) {
          if (releasePolicy) break;
          if (!tpl || typeof tpl !== "object") continue;
          const content = (tpl as any).content;
          if (!content || typeof content !== "object") continue;
          const en = (content as any)["en-us"] ?? (content as any)["en"];
          if (!en || typeof en !== "object") continue;
          for (const v of Object.values(en)) {
            if (releasePolicy) break;
            const body = typeof (v as any)?.body === "string" ? (v as any).body : undefined;
            if (!body) continue;
            const extracted = extractReleasePolicyFromText(body);
            if (extracted) releasePolicy = extracted;
          }
        }
      }

      const id = hit?.id?.resy ?? hit?.id ?? name;
      const key = String(id);

      const existing = byId.get(key);
      const next: VenueRow = {
        id,
        ...(typeof hit?.url_slug === "string" ? { urlSlug: hit.url_slug } : {}),
        name,
        neighborhood,
        ratingAverage: avg,
        ratingCount: count,
        ...(bookingWindowMaxDate ? { bookingWindowMaxDate } : {}),
        ...(bookingWindowDaysEstimate !== undefined ? { bookingWindowDaysEstimate } : {}),
        ...(invDates.length ? { inventoryDatesCount: invDates.length } : {}),
        ...(releasePolicy ?? {}),
      };

      // Keep the higher-rated entry if duplicates occur.
      if (!existing) byId.set(key, next);
      else if ((next.ratingAverage ?? 0) > (existing.ratingAverage ?? 0)) byId.set(key, next);
    }

    // If the API respects perPage, this is a good stop condition.
    if (hits.length < perPage) break;
  }

  const rows = Array.from(byId.values());
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


