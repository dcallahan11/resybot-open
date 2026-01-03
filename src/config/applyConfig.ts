import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { LocalStore } from "../store/store";
import type { Account, Schedule, Task } from "../store/schema";
import { BotConfigSchema, type BotConfig } from "./configSchema";

function minutesFromHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  const hour = Number(h);
  const minute = Number(m);
  return hour * 60 + minute;
}

export async function loadBotConfig(configPath: string): Promise<BotConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return BotConfigSchema.parse(parsed);
}

export async function applyBotConfig(input: {
  store: LocalStore;
  configPath: string;
}): Promise<{
  dataDir: string;
  accounts: number;
  tasks: number;
  schedules: number;
  proxies: number;
  webhookSet: boolean;
}> {
  const cfg = await loadBotConfig(input.configPath);
  const now = new Date().toISOString();

  const store = input.store;

  const accounts: Account[] = cfg.accounts.map((a) => ({
    id: randomUUID(),
    name: a.name.trim(),
    authToken: a.authToken.trim(),
    paymentId: a.paymentId,
    createdAt: now,
    updatedAt: now,
  }));

  const primary = accounts[0]!;
  const backup = accounts[1];

  const tasks: Task[] = cfg.reservations.map((r) => {
    const desiredMinutes = minutesFromHHMM(r.time);
    const startMin = Math.max(0, desiredMinutes - r.flexMinutes);
    const endMin = Math.min(23 * 60 + 59, desiredMinutes + r.flexMinutes);
    const startHour = Math.floor(startMin / 60);
    const endHour = Math.floor(endMin / 60);

    return {
      id: randomUUID(),
      accountId: primary.id,
      backupAccountId: backup?.id,
      restaurantId: r.restaurantId,
      restaurantName: r.restaurantName,
      partySize: r.partySize,
      startDate: r.date,
      endDate: r.date,
      desiredTime: r.time,
      flexMinutes: r.flexMinutes,
      startHour,
      endHour,
      delayMs: r.pollDelayMs,
      createdAt: now,
      updatedAt: now,
    };
  });

  const schedules: Schedule[] = [];
  for (let i = 0; i < cfg.reservations.length; i++) {
    const r = cfg.reservations[i]!;
    const task = tasks[i]!;
    if (!r.run) continue;

    const base = {
      id: randomUUID(),
      taskId: task.id,
      kind: r.run.kind,
      durationSec: r.run.durationSec,
      enabled: r.run.enabled,
      createdAt: now,
      updatedAt: now,
    } as const;

    if (r.run.kind === "once") {
      schedules.push({
        ...base,
        kind: "once",
        runAt: r.run.runAt,
      });
    } else if (r.run.kind === "daily") {
      schedules.push({
        ...base,
        kind: "daily",
        time: r.run.time,
      });
    } else {
      schedules.push({
        ...base,
        kind: "weekly",
        time: r.run.time,
        dayOfWeek: r.run.dayOfWeek,
      });
    }
  }

  // Replace data store contents with config-driven values
  await store.setAccounts(accounts);
  await store.setTasks(tasks);
  await store.setSchedules(schedules);
  await store.setProxies(cfg.proxies);
  await store.setDiscordWebhook(cfg.discordWebhook);

  return {
    dataDir: store.baseDir,
    accounts: accounts.length,
    tasks: tasks.length,
    schedules: schedules.length,
    proxies: cfg.proxies.length,
    webhookSet: Boolean(cfg.discordWebhook),
  };
}

export async function defaultConfigPath(): Promise<string> {
  // Default to repo root file name. Allow override via env.
  const fromEnv = process.env.RESYBOT_CONFIG;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "resybot.config.json");
}


