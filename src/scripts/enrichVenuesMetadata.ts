import { promises as fs } from "node:fs";
import path from "node:path";
import { ResyClient, ResyHttpError } from "../resy/resyClient";

type VenueRow = Record<string, unknown> & {
  id: number | string;
  name?: string;
  urlSlug?: string;
  neighborhood?: string;
};

export type EnrichedVenueMeta = {
  scrapedAt: string;
  locationSlug: string;
  timezone: string;

  // From /2/config
  venueConfig?: {
    leadTimeInDays?: number;
    calendarDateFrom?: string;
    calendarDateTo?: string;
    minBookHour?: number;
    maxBookHour?: number;
    minPartySize?: number;
    maxPartySize?: number;
    largePartyMessage?: string;
  };

  // From /3/venue -> content["need_to_know"]
  releasePolicy?: {
    status: "ok" | "missing_release_time" | "missing_need_to_know" | "missing_url_slug" | "error";
    releaseTimeLocal?: string; // HH:MM, 24h
    releasePolicyTextDaysInAdvance?: number;
    releasePolicyTextSnippet?: string;
    errorMessage?: string;
  };

  // Cached raw payloads (for “down the road” use)
  rawPaths?: {
    venueJson?: string;
    configJson?: string;
  } | undefined;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickSnippet(text: string, max = 600): string {
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

  const candidates = lines.filter((line) => {
    const l = line.toLowerCase();
    if (!l.includes("reservation")) return false;
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

  for (const line of candidates) {
    const lower = line.toLowerCase();
    if (/\b(midnight)\b/.test(lower)) return "00:00";
    if (/\b(noon)\b/.test(lower)) return "12:00";

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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function isAlreadyEnriched(row: VenueRow): boolean {
  const meta = (row as any).meta;
  return Boolean(meta && typeof meta === "object" && typeof meta.scrapedAt === "string" && meta.scrapedAt.length > 0);
}

export async function enrichVenuesMetadata(input: {
  venuesFile: string;
  outFile?: string;
  locationSlug: string;
  timezone?: string;
  cacheDir?: string;
  writeRaw?: boolean;
  start: number;
  limit: number;
  delayMs: number;
  force?: boolean;
}): Promise<{ outFile: string; cacheDir: string; processed: number; total: number }> {
  const venuesPath = path.resolve(input.venuesFile);
  const outPath = path.resolve(input.outFile ?? input.venuesFile);
  const cacheDir = path.resolve(input.cacheDir ?? "data/venue-meta");
  const timezone = input.timezone ?? "America/New_York";
  const writeRaw = input.writeRaw ?? true;

  const raw = await fs.readFile(venuesPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Expected venues file to be a JSON array: ${input.venuesFile}`);
  const venues = parsed as VenueRow[];

  // If outFile exists, prefer it as the baseline so re-runs append/continue cleanly.
  const existingOut = await readJsonIfExists(outPath);
  const outVenues =
    existingOut && Array.isArray(existingOut) && existingOut.length === venues.length ? (existingOut as VenueRow[]) : venues;

  const total = outVenues.length;
  const slice = outVenues.slice(input.start, input.start + input.limit);

  const resy = new ResyClient();
  let processed = 0;

  for (let i = 0; i < slice.length; i++) {
    const row = slice[i]!;
    const globalIndex = input.start + i;
    const nowIso = new Date().toISOString();

    if (!input.force && isAlreadyEnriched(row)) continue;

    const venueId = Number(row.id);
    if (!Number.isInteger(venueId)) continue;

    const urlSlug = typeof row.urlSlug === "string" ? row.urlSlug : undefined;
    const venueDir = path.join(cacheDir, String(venueId));
    const venueJsonPath = path.join(venueDir, "venue.json");
    const configJsonPath = path.join(venueDir, "config.json");

    const meta: EnrichedVenueMeta = {
      scrapedAt: nowIso,
      locationSlug: input.locationSlug,
      timezone,
      rawPaths: writeRaw ? { venueJson: venueJsonPath, configJson: configJsonPath } : undefined,
      releasePolicy: { status: "error" },
    };

    // /2/config (structured-ish)
    try {
      const cfg = await resy.getVenueConfig({ venueId });
      if (writeRaw) await writeJson(configJsonPath, cfg);

      meta.venueConfig = {
        ...(typeof cfg?.lead_time_in_days === "number" ? { leadTimeInDays: cfg.lead_time_in_days } : {}),
        ...(typeof cfg?.calendar_date_from === "string" ? { calendarDateFrom: cfg.calendar_date_from } : {}),
        ...(typeof cfg?.calendar_date_to === "string" ? { calendarDateTo: cfg.calendar_date_to } : {}),
        ...(typeof cfg?.min_book_hour === "number" ? { minBookHour: cfg.min_book_hour } : {}),
        ...(typeof cfg?.max_book_hour === "number" ? { maxBookHour: cfg.max_book_hour } : {}),
        ...(typeof cfg?.min_party_size === "number" ? { minPartySize: cfg.min_party_size } : {}),
        ...(typeof cfg?.max_party_size === "number" ? { maxPartySize: cfg.max_party_size } : {}),
        ...(typeof cfg?.large_party_message === "string" ? { largePartyMessage: cfg.large_party_message } : {}),
      };
    } catch (err) {
      // Keep going; still try /3/venue
    }

    // /3/venue -> need_to_know text + raw venue payload
    try {
      if (!urlSlug) {
        meta.releasePolicy = { status: "missing_url_slug" };
      } else {
        const venue = await resy.getVenueBySlug({ locationSlug: input.locationSlug, urlSlug });
        if (writeRaw) await writeJson(venueJsonPath, venue);

        const content: any[] = Array.isArray((venue as any)?.content) ? (venue as any).content : [];
        const ntk = content.find((c) => c && typeof c === "object" && c.name === "need_to_know");
        const body = typeof (ntk as any)?.body === "string" ? (ntk as any).body : undefined;
        if (!body) {
          meta.releasePolicy = { status: "missing_need_to_know" };
        } else {
          const releaseTime = parseReleaseTimeLocal(body);
          const daysText = parseDaysInAdvance(body);
          meta.releasePolicy = {
            status: releaseTime ? "ok" : "missing_release_time",
            ...(releaseTime ? { releaseTimeLocal: releaseTime } : {}),
            ...(daysText !== undefined ? { releasePolicyTextDaysInAdvance: daysText } : {}),
            releasePolicyTextSnippet: pickSnippet(body),
          };
        }
      }
    } catch (err) {
      if (err instanceof ResyHttpError) {
        meta.releasePolicy = { status: "error", errorMessage: `${err.status} ${err.url}` };
      } else {
        meta.releasePolicy = { status: "error", errorMessage: err instanceof Error ? err.message : String(err) };
      }
    }

    // Merge into the row (keep backwards compatibility for existing scripts).
    (outVenues[globalIndex] as any).meta = meta;
    if (meta.venueConfig?.leadTimeInDays !== undefined) (outVenues[globalIndex] as any).leadTimeInDays = meta.venueConfig.leadTimeInDays;
    if (meta.releasePolicy?.releaseTimeLocal) (outVenues[globalIndex] as any).releaseTimeLocal = meta.releasePolicy.releaseTimeLocal;

    processed++;
    await writeJson(outPath, outVenues);

    const jitter = Math.floor(Math.random() * 75);
    await sleep(Math.max(0, input.delayMs) + jitter);
  }

  return { outFile: outPath, cacheDir, processed, total };
}


