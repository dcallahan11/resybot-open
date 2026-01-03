import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AccountsSchema,
  AppInfo,
  AppInfoSchema,
  ProxiesSchema,
  SchedulesSchema,
  Schedule,
  TasksSchema,
  Task,
  Account,
} from "./schema";

type JsonReadResult<T> = { ok: true; value: T } | { ok: false; error: Error };

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  defaultValue: T,
): Promise<JsonReadResult<T>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const value = schema.parse(parsed);
    return { ok: true, value };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as any).code === "ENOENT") {
      return { ok: true, value: defaultValue };
    }
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpPath, json, "utf8");
  try {
    // On Windows, rename over existing can be flaky. Remove then rename.
    await fs.rm(filePath, { force: true });
  } catch {
    // ignore
  }
  await fs.rename(tmpPath, filePath);
}

export class LocalStore {
  readonly baseDir: string;

  constructor(opts?: { baseDir?: string }) {
    const baseDir = opts?.baseDir ?? process.env.RESYBOT_DATA_DIR ?? path.join(process.cwd(), "data");
    this.baseDir = baseDir;
  }

  private accountsPath(): string {
    return path.join(this.baseDir, "accounts.json");
  }
  private tasksPath(): string {
    return path.join(this.baseDir, "tasks.json");
  }
  private schedulesPath(): string {
    return path.join(this.baseDir, "schedules.json");
  }
  private proxiesPath(): string {
    return path.join(this.baseDir, "proxies.json");
  }
  private infoPath(): string {
    return path.join(this.baseDir, "info.json");
  }

  // ---- Info ----
  async getInfo(): Promise<AppInfo> {
    const res = await readJsonFile(this.infoPath(), AppInfoSchema, {});
    if (!res.ok) throw new Error(`Failed to read info.json: ${res.error.message}`);
    return res.value;
  }

  async setDiscordWebhook(webhookUrl: string | undefined): Promise<void> {
    const next: AppInfo = webhookUrl ? { discordWebhook: webhookUrl } : {};
    await atomicWriteJson(this.infoPath(), AppInfoSchema.parse(next));
  }

  // ---- Accounts ----
  async listAccounts(): Promise<Account[]> {
    const res = await readJsonFile(this.accountsPath(), AccountsSchema, []);
    if (!res.ok) throw new Error(`Failed to read accounts.json: ${res.error.message}`);
    return res.value;
  }

  async setAccounts(accounts: Account[]): Promise<void> {
    await atomicWriteJson(this.accountsPath(), AccountsSchema.parse(accounts));
  }

  async getAccount(accountId: string): Promise<Account | undefined> {
    const accounts = await this.listAccounts();
    return accounts.find((a) => a.id === accountId);
  }

  async addAccount(input: { name: string; authToken: string; paymentId: number }): Promise<Account> {
    const now = new Date().toISOString();
    const accounts = await this.listAccounts();
    const account: Account = {
      id: randomUUID(),
      name: input.name.trim(),
      authToken: input.authToken.trim(),
      paymentId: input.paymentId,
      createdAt: now,
      updatedAt: now,
    };
    accounts.push(account);
    await atomicWriteJson(this.accountsPath(), AccountsSchema.parse(accounts));
    return account;
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    const accounts = await this.listAccounts();
    const next = accounts.filter((a) => a.id !== accountId);
    if (next.length === accounts.length) return false;
    await atomicWriteJson(this.accountsPath(), AccountsSchema.parse(next));
    return true;
  }

  // ---- Tasks ----
  async listTasks(): Promise<Task[]> {
    const res = await readJsonFile(this.tasksPath(), TasksSchema, []);
    if (!res.ok) throw new Error(`Failed to read tasks.json: ${res.error.message}`);
    return res.value;
  }

  async setTasks(tasks: Task[]): Promise<void> {
    await atomicWriteJson(this.tasksPath(), TasksSchema.parse(tasks));
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    const tasks = await this.listTasks();
    return tasks.find((t) => t.id === taskId);
  }

  async addTask(input: Omit<Task, "id" | "createdAt" | "updatedAt">): Promise<Task> {
    const now = new Date().toISOString();
    const tasks = await this.listTasks();
    const task: Task = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    tasks.push(task);
    await atomicWriteJson(this.tasksPath(), TasksSchema.parse(tasks));
    return task;
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const tasks = await this.listTasks();
    const next = tasks.filter((t) => t.id !== taskId);
    if (next.length === tasks.length) return false;
    await atomicWriteJson(this.tasksPath(), TasksSchema.parse(next));
    return true;
  }

  // ---- Schedules ----
  async listSchedules(): Promise<Schedule[]> {
    const res = await readJsonFile(this.schedulesPath(), SchedulesSchema, []);
    if (!res.ok) throw new Error(`Failed to read schedules.json: ${res.error.message}`);
    return res.value;
  }

  async setSchedules(schedules: Schedule[]): Promise<void> {
    await atomicWriteJson(this.schedulesPath(), SchedulesSchema.parse(schedules));
  }

  async getSchedule(scheduleId: string): Promise<Schedule | undefined> {
    const schedules = await this.listSchedules();
    return schedules.find((s) => s.id === scheduleId);
  }

  async upsertSchedule(schedule: Schedule): Promise<void> {
    const schedules = await this.listSchedules();
    const idx = schedules.findIndex((s) => s.id === schedule.id);
    const next = [...schedules];
    if (idx === -1) next.push(schedule);
    else next[idx] = schedule;
    await atomicWriteJson(this.schedulesPath(), SchedulesSchema.parse(next));
  }

  async addSchedule(input: Omit<Schedule, "id" | "createdAt" | "updatedAt">): Promise<Schedule> {
    const now = new Date().toISOString();
    const schedule: Schedule = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    await this.upsertSchedule(schedule);
    return schedule;
  }

  async deleteSchedule(scheduleId: string): Promise<boolean> {
    const schedules = await this.listSchedules();
    const next = schedules.filter((s) => s.id !== scheduleId);
    if (next.length === schedules.length) return false;
    await atomicWriteJson(this.schedulesPath(), SchedulesSchema.parse(next));
    return true;
  }

  async setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<boolean> {
    const schedule = await this.getSchedule(scheduleId);
    if (!schedule) return false;
    const next: Schedule = {
      ...schedule,
      enabled,
      updatedAt: new Date().toISOString(),
    };
    await this.upsertSchedule(next);
    return true;
  }

  // ---- Proxies ----
  async listProxies(): Promise<string[]> {
    const res = await readJsonFile(this.proxiesPath(), ProxiesSchema, []);
    if (!res.ok) throw new Error(`Failed to read proxies.json: ${res.error.message}`);
    return res.value;
  }

  async setProxies(proxies: string[]): Promise<void> {
    await atomicWriteJson(this.proxiesPath(), ProxiesSchema.parse(proxies));
  }

  async addProxies(proxies: string[]): Promise<void> {
    const existing = await this.listProxies();
    const normalized = proxies.map((p) => p.trim()).filter(Boolean);
    const next = Array.from(new Set([...existing, ...normalized]));
    await atomicWriteJson(this.proxiesPath(), ProxiesSchema.parse(next));
  }

  async deleteProxy(proxyValue: string): Promise<boolean> {
    const proxies = await this.listProxies();
    const next = proxies.filter((p) => p !== proxyValue);
    if (next.length === proxies.length) return false;
    await atomicWriteJson(this.proxiesPath(), ProxiesSchema.parse(next));
    return true;
  }

  async clearProxies(): Promise<void> {
    await atomicWriteJson(this.proxiesPath(), ProxiesSchema.parse([]));
  }
}


