import { promises as fs } from "node:fs";
import path from "node:path";
import { type ReservationConfig } from "../config/configSchema";

export async function mergeReservationsIntoConfig(input: {
  configFile: string;
  reservationsFile: string;
  mode: "append" | "replace";
}): Promise<{ configFile: string; reservationsWritten: number }> {
  const configPath = path.resolve(input.configFile);
  const reservationsPath = path.resolve(input.reservationsFile);

  const cfgRaw = await fs.readFile(configPath, "utf8");
  const cfgJson = JSON.parse(cfgRaw) as any;
  if (!cfgJson || typeof cfgJson !== "object") throw new Error("Config file is not a JSON object");
  const existingReservations: unknown = cfgJson.reservations;
  const existingList = Array.isArray(existingReservations) ? existingReservations : [];

  const resRaw = await fs.readFile(reservationsPath, "utf8");
  const resJson = JSON.parse(resRaw) as unknown;
  if (!Array.isArray(resJson)) throw new Error(`Expected ${input.reservationsFile} to be a JSON array`);
  const reservations = resJson as ReservationConfig[];

  const next = {
    ...cfgJson,
    reservations: input.mode === "replace" ? reservations : [...existingList, ...reservations],
  } as any;

  await fs.writeFile(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return { configFile: configPath, reservationsWritten: reservations.length };
}


