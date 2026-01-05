import { ResyClient } from "../resy/resyClient";

export type DiscoveredVenueRow = {
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
  releasePolicyTime?: string; // HH:MM 24h
  releasePolicySnippet?: string;
};

function parseDateOnlyUTC(yyyyMmDd: string): number | undefined {
  const m = yyyyMmDd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
  return Number.isFinite(t) ? t : undefined;
}

function extractReleasePolicyFromText(
  text: string,
):
  | Pick<DiscoveredVenueRow, "releasePolicyDaysInAdvance" | "releasePolicyTime" | "releasePolicySnippet">
  | undefined {
  const lower = text.toLowerCase();
  if (!lower.includes("reserv")) return undefined;

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

  const snippet = text.length > 260 ? `${text.slice(0, 260)}…` : text;
  return {
    ...(days !== undefined ? { releasePolicyDaysInAdvance: days } : {}),
    ...(time !== undefined ? { releasePolicyTime: time } : {}),
    releasePolicySnippet: snippet,
  };
}

export async function discoverTopRatedVenues(input: {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  day: string;
  partySize: number;
  minRating: number;
  minRatingCount?: number;
  query?: string;
  orderBy?: string;
  availability?: boolean;
  neighborhoodContains?: string;
  perPage?: number;
  maxPages?: number;
}): Promise<DiscoveredVenueRow[]> {
  const resy = new ResyClient();
  const perPage = input.perPage ?? 50;
  const maxPages = input.maxPages ?? 10;
  const refTs = parseDateOnlyUTC(input.day);

  const byId = new Map<string, DiscoveredVenueRow>();
  const neighborhoodNeedle = input.neighborhoodContains?.trim().toLowerCase();

  for (let page = 1; page <= maxPages; page++) {
    const resp = await resy.venueSearch({
      day: input.day,
      partySize: input.partySize,
      page,
      perPage,
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radiusMeters,
      query: input.query ?? "",
      orderBy: input.orderBy ?? "distance",
      availability: input.availability ?? false,
    });

    const hits: any[] = Array.isArray(resp?.search?.hits) ? resp.search.hits : [];
    if (hits.length === 0) break;

    for (const hit of hits) {
      const name = typeof hit?.name === "string" ? hit.name : undefined;
      if (!name) continue;

      const neighborhood = typeof hit?.neighborhood === "string" ? hit.neighborhood : undefined;
      if (neighborhoodNeedle) {
        if (!neighborhood || !neighborhood.toLowerCase().includes(neighborhoodNeedle)) continue;
      }

      const avg = typeof hit?.rating?.average === "number" ? hit.rating.average : undefined;
      const count = typeof hit?.rating?.count === "number" ? hit.rating.count : undefined;
      if (avg === undefined || avg <= input.minRating) continue;
      if (input.minRatingCount !== undefined && (count === undefined || count < input.minRatingCount)) continue;

      const invDatesRaw: unknown = hit?.inventory_reservation;
      const invDates = Array.isArray(invDatesRaw)
        ? (invDatesRaw.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) as string[])
        : [];
      const bookingWindowMaxDate = invDates.length ? invDates.slice().sort().at(-1) : undefined;
      const maxTs = bookingWindowMaxDate ? parseDateOnlyUTC(bookingWindowMaxDate) : undefined;
      const bookingWindowDaysEstimate =
        refTs !== undefined && maxTs !== undefined ? Math.round((maxTs - refTs) / 86_400_000) : undefined;

      let releasePolicy:
        | Pick<DiscoveredVenueRow, "releasePolicyDaysInAdvance" | "releasePolicyTime" | "releasePolicySnippet">
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

      const next: DiscoveredVenueRow = {
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

      const existing = byId.get(key);
      if (!existing) byId.set(key, next);
      else if ((next.ratingAverage ?? 0) > (existing.ratingAverage ?? 0)) byId.set(key, next);
    }

    if (hits.length < perPage) break;
  }

  return Array.from(byId.values());
}


