import { promises as fs } from "node:fs";
import path from "node:path";

type VenueInput = {
  id: number | string;
  name: string;
  ratingAverage?: number;
};

export type GeneratedReservation = {
  restaurantName: string;
  restaurantId: string;
  date: string;
  time: string;
  flexMinutes: number;
  partySize: number;
  pollDelayMs: number;
};

function toDateOnly(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateOnlyLocal(yyyyMmDd: string): Date {
  const m = yyyyMmDd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date: ${yyyyMmDd} (expected YYYY-MM-DD)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return new Date(y, mo - 1, d, 0, 0, 0, 0);
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

export async function generateWeekendReservations(input: {
  venuesFile: string;
  count: number;
  startDate?: string;
  partySize: number;
  time: string;
  flexMinutes: number;
  pollDelayMs: number;
  outFile: string;
}): Promise<{ outFile: string; reservations: GeneratedReservation[] }> {
  const venuesPath = path.resolve(input.venuesFile);
  const raw = await fs.readFile(venuesPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Expected ${input.venuesFile} to be a JSON array`);

  const venues: VenueInput[] = parsed
    .filter((v) => v && typeof v === "object" && "id" in (v as any) && "name" in (v as any))
    .map((v) => ({
      id: (v as any).id,
      name: String((v as any).name),
      ratingAverage: typeof (v as any).ratingAverage === "number" ? (v as any).ratingAverage : undefined,
    }));

  venues.sort((a, b) => (b.ratingAverage ?? 0) - (a.ratingAverage ?? 0));

  const selected = venues.slice(0, input.count);
  if (selected.length < input.count) {
    throw new Error(`Not enough venues in file (needed ${input.count}, found ${selected.length})`);
  }

  const dates = nextWeekendDates(input.count, input.startDate);

  // Default desired dining window: 7:30–9:00pm can be represented as time=20:15 flex=45.
  const reservations: GeneratedReservation[] = selected.map((v, idx) => ({
    restaurantName: v.name,
    restaurantId: String(v.id),
    date: dates[idx]!,
    time: input.time,
    flexMinutes: input.flexMinutes,
    partySize: input.partySize,
    pollDelayMs: input.pollDelayMs,
  }));

  const outPath = path.resolve(input.outFile);
  await fs.writeFile(outPath, JSON.stringify(reservations, null, 2) + "\n", "utf8");

  return { outFile: outPath, reservations };
}


