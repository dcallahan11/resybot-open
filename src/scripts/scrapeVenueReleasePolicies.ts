import { promises as fs } from "node:fs";
import path from "node:path";
import { ResyClient, ResyHttpError } from "../resy/resyClient";

type VenueInput = {
  id: number | string;
  name?: string;
  urlSlug?: string;
  neighborhood?: string;
};

export type VenueReleasePolicy = {
  venueId: number;
  name: string;
  urlSlug?: string;
  neighborhood?: string;
  locationSlug: string;

  // From /2/config
  leadTimeInDays?: number; // difference in days from today -> furthest bookable day
  leadTimeInclusiveDays?: number; // convenience (= leadTimeInDays + 1)

  // From /3/venue need_to_know parsing
  releaseTimeLocal?: string; // HH:MM, 24h
  releaseTimeTimezone?: string; // IANA, e.g. America/New_York
  releasePolicyTextDaysInAdvance?: number; // e.g. 21 from "up to 21 days in advance"
  releasePolicyTextSnippet?: string;

  status: "ok" | "missing_release_time" | "missing_need_to_know" | "missing_url_slug" | "error";
  updatedAt: string;
  errorMessage?: string;
};

type OutputFile = {
  generatedAt: string;
  locationSlug: string;
  policies: Record<string, VenueReleasePolicy>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickSnippet(text: string, max = 400): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
}

function parseDaysInAdvance(text: string): number | undefined {
  const lower = text.toLowerCase();
  const m =
    lower.match(/\bup\s*to\s*(\d{1,2})\s*days?\s*in\s*advance\b/) ??
    lower.match(/\b(\d{1,2})\s*days?\s*in\s*advance\b/) ??
    lower.match(/\b(\d{1,2})\s*days?\s*(?:ahead|out)\b/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0 || n > 366) return undefined;
  return n;
}

function parseReleaseTimeLocal(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // We only trust times that appear in "release policy" style copy.
  const candidates = lines.filter((line) => {
    const l = line.toLowerCase();
    const hasReservationWord = l.includes("reservation");
    if (!hasReservationWord) return false;

    // Keywords that usually describe when the booking window "drops".
    // (We keep this fairly strict to avoid false positives like "Dinner reservations start at 6:15pm".)
    return (
      /\bin\s+advance\b/.test(l) ||
      /\bdays?\s+in\s+advance\b/.test(l) ||
      /\bavailable\s+up\s+to\b/.test(l) ||
      /\bnew\s+date\b/.test(l) ||
      /\bbecoming\s+available\b/.test(l) ||
      /\bbecome\s+available\b/.test(l) ||
      /\breservations?\s+(?:open|opens|opening)\b/.test(l) ||
      /\breservations?\s+release\b/.test(l) ||
      /\breservations?\s+(?:are\s+)?released\b/.test(l) ||
      /\breleased\s+daily\b/.test(l) ||
      /\bbooking\s+window\b/.test(l)
    );
  });

  if (candidates.length === 0) return undefined;

  for (const line of candidates) {
    const lower = line.toLowerCase();

    // Special cases
    if (/\b(midnight)\b/.test(lower)) return "00:00";
    if (/\b(noon)\b/.test(lower)) return "12:00";

    // Common patterns: "at 9 AM", "at 9AM", "at 9:00 a.m."
    // Supports "9 AM", "9AM", "9 a.m.", and shorthand "10a"/"10p".
    const m = lower.match(/\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|a|p)\b/);
    if (!m) continue;

    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const ampmRaw = m[3];
    if (!ampmRaw) continue;
    const ampm = ampmRaw.startsWith("p") ? "pm" : "am";

    if (!Number.isInteger(hour) || hour < 1 || hour > 12) continue;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) continue;

    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  return undefined;
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as any).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function scrapeVenueReleasePolicies(input: {
  venuesFile: string;
  locationSlug: string;
  start: number;
  limit: number;
  delayMs: number;
  outFile: string;
  timezone?: string;
  force?: boolean;
}): Promise<{ outFile: string; processed: number; total: number }> {
  const venuesPath = path.resolve(input.venuesFile);
  const outPath = path.resolve(input.outFile);
  const timezone = input.timezone ?? "America/New_York";

  const raw = await fs.readFile(venuesPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Expected venues file to be a JSON array: ${input.venuesFile}`);

  const venues: VenueInput[] = parsed
    .filter((v) => v && typeof v === "object" && "id" in (v as any))
    .map((v) => ({
      id: (v as any).id,
      name: typeof (v as any).name === "string" ? (v as any).name : undefined,
      urlSlug: typeof (v as any).urlSlug === "string" ? (v as any).urlSlug : undefined,
      neighborhood: typeof (v as any).neighborhood === "string" ? (v as any).neighborhood : undefined,
    }));

  const total = venues.length;
  const slice = venues.slice(input.start, input.start + input.limit);

  const existing = await readJsonIfExists(outPath);
  const output: OutputFile =
    existing && typeof existing === "object"
      ? {
          generatedAt: (existing as any).generatedAt ?? new Date().toISOString(),
          locationSlug: (existing as any).locationSlug ?? input.locationSlug,
          policies: (existing as any).policies ?? {},
        }
      : { generatedAt: new Date().toISOString(), locationSlug: input.locationSlug, policies: {} };

  const resy = new ResyClient();
  let processed = 0;

  for (const v of slice) {
    const nowIso = new Date().toISOString();
    const venueId = Number(v.id);
    if (!Number.isInteger(venueId)) continue;

    // Skip if already present and not error (lets you resume over multiple runs).
    const existingPolicy = output.policies[String(venueId)];
    if (!input.force && existingPolicy && existingPolicy.status !== "error") continue;

    let policy: VenueReleasePolicy = {
      venueId,
      name: v.name ?? `venue:${venueId}`,
      ...(v.urlSlug ? { urlSlug: v.urlSlug } : {}),
      ...(v.neighborhood ? { neighborhood: v.neighborhood } : {}),
      locationSlug: input.locationSlug,
      releaseTimeTimezone: timezone,
      status: "error",
      updatedAt: nowIso,
    };

    try {
      // 1) lead time (days)
      const cfg = await resy.getVenueConfig({ venueId });
      const lead = typeof cfg?.lead_time_in_days === "number" ? cfg.lead_time_in_days : undefined;
      if (lead !== undefined && Number.isInteger(lead) && lead >= 0 && lead <= 366) {
        policy = {
          ...policy,
          leadTimeInDays: lead,
          leadTimeInclusiveDays: lead + 1,
        };
      }

      // 2) need_to_know text (exact time)
      if (!v.urlSlug) {
        policy = { ...policy, status: "missing_url_slug" };
      } else {
        const venue = await resy.getVenueBySlug({ locationSlug: input.locationSlug, urlSlug: v.urlSlug });
        const content: any[] = Array.isArray(venue?.content) ? venue.content : [];
        const ntk = content.find((c) => c && typeof c === "object" && c.name === "need_to_know");
        const body = typeof ntk?.body === "string" ? ntk.body : undefined;
        if (!body) {
          policy = { ...policy, status: "missing_need_to_know" };
        } else {
          const releaseTime = parseReleaseTimeLocal(body);
          const daysText = parseDaysInAdvance(body);
          policy = {
            ...policy,
            ...(releaseTime ? { releaseTimeLocal: releaseTime } : {}),
            ...(daysText !== undefined ? { releasePolicyTextDaysInAdvance: daysText } : {}),
            releasePolicyTextSnippet: pickSnippet(body),
            status: releaseTime ? "ok" : "missing_release_time",
          };
        }
      }
    } catch (err) {
      if (err instanceof ResyHttpError) {
        policy = { ...policy, status: "error", errorMessage: `${err.status} ${err.url}` };
      } else {
        policy = { ...policy, status: "error", errorMessage: err instanceof Error ? err.message : String(err) };
      }
    }

    output.policies[String(venueId)] = policy;
    processed++;

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");

    // Rate limiting: jitter + delay between venues
    const jitter = Math.floor(Math.random() * 75);
    await sleep(Math.max(0, input.delayMs) + jitter);
  }

  return { outFile: outPath, processed, total };
}


