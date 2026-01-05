import tzLookup from "tz-lookup";

export function timezoneForCoordinates(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("lat/lon must be finite numbers");
  return tzLookup(lat, lon);
}

function partsToObject(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  return out;
}

function parseOffsetToMinutes(offset: string): number | undefined {
  // Expects formats like "GMT-05:00" or "UTC+01:00" or "GMT-5".
  const m = offset.match(/([+-])\s*(\d{1,2})(?::?(\d{2}))?/i);
  if (!m) return undefined;
  const sign = m[1] === "-" ? -1 : 1;
  const hh = Number(m[2]);
  const mm = m[3] ? Number(m[3]) : 0;
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) return undefined;
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) return undefined;
  return sign * (hh * 60 + mm);
}

/**
 * Convert a "local" date+time in a given IANA timezone into an ISO string (UTC, with Z).
 * This avoids relying on the machine's local timezone.
 */
export function zonedLocalToUtcIso(input: {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  timeZone: string; // IANA, e.g. America/New_York
  seconds?: number;
  milliseconds?: number;
}): string {
  const mDate = input.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mTime = input.time.match(/^(\d{2}):(\d{2})$/);
  if (!mDate) throw new Error(`Invalid date: ${input.date}`);
  if (!mTime) throw new Error(`Invalid time: ${input.time}`);
  const year = Number(mDate[1]);
  const month = Number(mDate[2]);
  const day = Number(mDate[3]);
  const hour = Number(mTime[1]);
  const minute = Number(mTime[2]);
  const seconds = input.seconds ?? 0;
  const ms = input.milliseconds ?? 0;

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "shortOffset",
  } as const);

  // Start with naive UTC guess and converge to stable offset.
  let utc = Date.UTC(year, month - 1, day, hour, minute, seconds, ms);
  for (let i = 0; i < 4; i++) {
    const parts = partsToObject(dtf.formatToParts(new Date(utc)));
    const tzName = parts.timeZoneName;
    if (!tzName) break;
    const offsetMin = parseOffsetToMinutes(tzName);
    if (offsetMin === undefined) break;
    const nextUtc = Date.UTC(year, month - 1, day, hour, minute, seconds, ms) - offsetMin * 60_000;
    if (nextUtc === utc) break;
    utc = nextUtc;
  }
  return new Date(utc).toISOString();
}


