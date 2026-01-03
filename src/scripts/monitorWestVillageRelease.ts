import { promises as fs } from "node:fs";
import path from "node:path";
import { runWestVillageTopRated, defaultWestVillageTopRatedOptions } from "./westVillageTopRated";

type ReleaseEvent = {
  at: string;
  venueId: string;
  name: string;
  prevMaxDate?: string;
  newMaxDate: string;
  bookingWindowDaysEstimate?: number;
};

type MonitorState = {
  lastSeenMaxDateByVenueId: Record<string, string | undefined>;
  events: ReleaseEvent[];
};

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as any).code === "ENOENT") return undefined;
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function monitorWestVillageRelease(input: {
  minRating?: number;
  radiusMeters?: number;
  intervalSec: number;
  durationMin: number;
  stateFile: string;
}): Promise<{ stateFile: string; events: number }> {
  const defaults = defaultWestVillageTopRatedOptions();
  const minRating = input.minRating ?? defaults.minRating;
  const radiusMeters = input.radiusMeters ?? defaults.radiusMeters;

  const statePath = path.resolve(input.stateFile);
  const existing = await readJsonIfExists(statePath);

  const state: MonitorState =
    existing && typeof existing === "object"
      ? {
          lastSeenMaxDateByVenueId: (existing as any).lastSeenMaxDateByVenueId ?? {},
          events: Array.isArray((existing as any).events) ? (existing as any).events : [],
        }
      : { lastSeenMaxDateByVenueId: {}, events: [] };

  const start = Date.now();
  const end = start + Math.max(1, input.durationMin) * 60_000;

  while (Date.now() < end) {
    const rows = await runWestVillageTopRated({
      minRating,
      radiusMeters,
      day: defaults.day,
      partySize: defaults.partySize,
    });

    const nowIso = new Date().toISOString();

    for (const r of rows) {
      const id = String(r.id);
      const maxDate = r.bookingWindowMaxDate;
      if (!maxDate) continue;

      const prev = state.lastSeenMaxDateByVenueId[id];
      if (prev && maxDate > prev) {
        state.events.push({
          at: nowIso,
          venueId: id,
          name: r.name,
          prevMaxDate: prev,
          newMaxDate: maxDate,
          ...(r.bookingWindowDaysEstimate !== undefined ? { bookingWindowDaysEstimate: r.bookingWindowDaysEstimate } : {}),
        });
      }
      state.lastSeenMaxDateByVenueId[id] = maxDate;
    }

    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

    // Space out calls to avoid rate limiting
    const sleepMs = Math.max(1, input.intervalSec) * 1000;
    if (Date.now() + sleepMs >= end) break;
    await sleep(sleepMs);
  }

  return { stateFile: statePath, events: state.events.length };
}


