import { promises as fs } from "node:fs";
import path from "node:path";
import { zonedLocalToUtcIso } from "../location/timezone";

type LocationProfile = {
  place: string;
  timezone: string;
  resyLocationSlug: string;
  generatedAt: string;
};

type VenueRow = Record<string, unknown> & {
  id: number | string;
  urlSlug?: string;
  name: string;
  enabled?: boolean;
  leadTimeInDays?: number;
  releaseTimeLocal?: string;
  meta?: any;
};

type ReservationRun = {
  kind: "once";
  runAt: string; // ISO
  durationSec: number;
  enabled: boolean;
};

type GeneratedReservation = {
  restaurantName?: string;
  restaurantId: string;
  date: string;
  time: string;
  flexMinutes: number;
  partySize: number;
  pollDelayMs: number;
  run?: ReservationRun;
};

function parseDateOnlyLocal(yyyyMmDd: string): Date {
  const m = yyyyMmDd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date: ${yyyyMmDd} (expected YYYY-MM-DD)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return new Date(y, mo - 1, d, 0, 0, 0, 0);
}

function toDateOnly(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(dateOnly: string, deltaDays: number): string {
  const d = parseDateOnlyLocal(dateOnly);
  d.setDate(d.getDate() + deltaDays);
  return toDateOnly(d);
}

function nextWeekendDates(count: number, startDate?: string): string[] {
  const start = startDate ? parseDateOnlyLocal(startDate) : new Date();
  start.setHours(0, 0, 0, 0);

  const dates: string[] = [];
  const cur = new Date(start);

  while (dates.length < count) {
    const dow = cur.getDay(); // 0=Sun..6=Sat
    if (dow === 5 || dow === 6) {
      dates.push(toDateOnly(cur));
    }
    cur.setDate(cur.getDate() + 1);
  }

  return dates;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function leadTimeDaysForVenue(v: VenueRow): number | undefined {
  if (typeof v.leadTimeInDays === "number" && Number.isInteger(v.leadTimeInDays) && v.leadTimeInDays >= 0) return v.leadTimeInDays;
  const daysText = v?.meta?.releasePolicy?.releasePolicyTextDaysInAdvance;
  if (typeof daysText === "number" && Number.isInteger(daysText) && daysText > 0) return Math.max(0, daysText - 1);
  return undefined;
}

export async function locationStart(input: {
  locationDir: string;
  configFile: string;
  mode: "append" | "replace";
  startDate?: string;
  partySize: number;
  time: string;
  flexMinutes: number;
  pollDelayMs: number;
  defaultReleaseTime: string;
  unknownReleaseMode: "default" | "skip";
  startEarlySec: number;
  durationSec: number;
  apply: boolean;
  runRunner: boolean;
}): Promise<{
  locationDir: string;
  enabledVenues: number;
  reservationsWritten: number;
  reservationsFile: string;
  mergedIntoConfig: boolean;
  applied: boolean;
}> {
  const locationDir = path.resolve(input.locationDir);
  const locationPath = path.join(locationDir, "location.json");
  const venuesPath = path.join(locationDir, "venues.json");

  const locRaw = await fs.readFile(locationPath, "utf8");
  const venuesRaw = await fs.readFile(venuesPath, "utf8");
  const profile = JSON.parse(locRaw) as LocationProfile;
  const venues = JSON.parse(venuesRaw) as VenueRow[];
  if (!Array.isArray(venues)) throw new Error(`Expected venues.json to be an array: ${venuesPath}`);

  const enabled = venues.filter((v) => v.enabled);
  if (enabled.length === 0) throw new Error("No enabled venues. Edit venues.json and set enabled=true for some venues.");

  const dates = nextWeekendDates(enabled.length, input.startDate);
  const reservations: GeneratedReservation[] = [];

  for (let i = 0; i < enabled.length; i++) {
    const v = enabled[i]!;
    const diningDate = dates[i]!;
    const restaurantId = String(v.id);
    const restaurantName = v.name;

    const leadTime = leadTimeDaysForVenue(v);
    const releaseTime = typeof v.releaseTimeLocal === "string" ? v.releaseTimeLocal : undefined;
    const scheduleTime = releaseTime ?? input.defaultReleaseTime;

    let run: ReservationRun | undefined;
    if (leadTime !== undefined) {
      const openDate = addDays(diningDate, -leadTime);
      const openAtIso = zonedLocalToUtcIso({
        date: openDate,
        time: scheduleTime,
        timeZone: profile.timezone,
      });

      const runAtMs = new Date(openAtIso).getTime() - Math.max(0, input.startEarlySec) * 1000;
      const runAtIso = new Date(runAtMs).toISOString();

      run = {
        kind: "once",
        runAt: runAtIso,
        durationSec: input.durationSec,
        enabled: true,
      };
    } else if (input.unknownReleaseMode === "default") {
      // We don't know days-ahead window; leave run unset so user can decide (safer than guessing).
      run = undefined;
    } else {
      run = undefined;
    }

    reservations.push({
      restaurantName,
      restaurantId,
      date: diningDate,
      time: input.time,
      flexMinutes: input.flexMinutes,
      partySize: input.partySize,
      pollDelayMs: input.pollDelayMs,
      ...(run ? { run } : {}),
    });
  }

  const reservationsFile = path.join(locationDir, "reservations.generated.json");
  await writeJson(reservationsFile, reservations);

  const { mergeReservationsIntoConfig } = await import("./mergeReservationsIntoConfig");
  const mergeRes = await mergeReservationsIntoConfig({
    reservationsFile,
    configFile: input.configFile,
    mode: input.mode,
  });

  let applied = false;
  if (input.apply) {
    const { LocalStore } = await import("../store/store");
    const { applyBotConfig } = await import("../config/applyConfig");
    const store = new LocalStore();
    await applyBotConfig({ store, configPath: input.configFile });
    applied = true;
  }

  if (input.runRunner) {
    const { runRunner } = await import("../runner/runnerMain");
    await runRunner();
  }

  return {
    locationDir,
    enabledVenues: enabled.length,
    reservationsWritten: reservations.length,
    reservationsFile,
    mergedIntoConfig: Boolean(mergeRes?.reservationsWritten),
    applied,
  };
}


