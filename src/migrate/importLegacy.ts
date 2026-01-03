import { promises as fs } from "node:fs";
import path from "node:path";
import type { LocalStore } from "../store/store";
import type { Account, Task } from "../store/schema";

type LegacyAccount = {
  account_name?: string;
  auth_token?: string;
  payment_id?: string | number;
};

type LegacyTask = {
  account_name?: string;
  auth_token?: string;
  payment_id?: string | number;
  restaurant_id?: string;
  party_sz?: number;
  start_date?: string;
  end_date?: string;
  start_time?: number;
  end_time?: number;
  delay?: number;
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

function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isInteger(n)) return n;
  }
  return undefined;
}

function normalizeAccountName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function taskKey(task: Omit<Task, "id" | "createdAt" | "updatedAt">): string {
  return [
    task.accountId,
    task.restaurantId,
    String(task.partySize),
    task.startDate,
    task.endDate,
    String(task.startHour),
    String(task.endHour),
    String(task.delayMs),
  ].join("|");
}

export async function importLegacyPythonData(input: {
  store: LocalStore;
  legacyDir: string;
}): Promise<{ importedAccounts: number; importedTasks: number; importedProxies: number; importedWebhook: boolean }> {
  const { store } = input;
  const legacyDir = path.resolve(input.legacyDir);

  const legacyAccountsPath = path.join(legacyDir, "accounts.json");
  const legacyTasksPath = path.join(legacyDir, "tasks.json");
  const legacyProxiesPath = path.join(legacyDir, "proxies.json");
  const legacyInfoPath = path.join(legacyDir, "info.json");

  const existingAccounts = await store.listAccounts();
  const accountsByAuth = new Map(existingAccounts.map((a) => [a.authToken, a] as const));
  const accountsByName = new Map(existingAccounts.map((a) => [a.name, a] as const));

  let importedAccounts = 0;
  let importedTasks = 0;
  let importedProxies = 0;
  let importedWebhook = false;

  const legacyAccountsRaw = await readJsonIfExists(legacyAccountsPath);
  if (Array.isArray(legacyAccountsRaw)) {
    for (const a of legacyAccountsRaw) {
      if (!a || typeof a !== "object") continue;
      const la = a as LegacyAccount;
      const name = normalizeAccountName(la.account_name) ?? "Imported Account";
      const authToken = normalizeString(la.auth_token);
      const paymentId = toInt(la.payment_id);
      if (!authToken || paymentId === undefined) continue;

      const existing = accountsByAuth.get(authToken) ?? accountsByName.get(name);
      if (existing) continue;

      const created = await store.addAccount({ name, authToken, paymentId });
      accountsByAuth.set(created.authToken, created);
      accountsByName.set(created.name, created);
      importedAccounts++;
    }
  }

  const legacyProxiesRaw = await readJsonIfExists(legacyProxiesPath);
  if (Array.isArray(legacyProxiesRaw)) {
    const proxies = legacyProxiesRaw.filter((p) => typeof p === "string" && p.trim() !== "") as string[];
    await store.addProxies(proxies);
    importedProxies = proxies.length;
  }

  const legacyInfoRaw = await readJsonIfExists(legacyInfoPath);
  if (legacyInfoRaw && typeof legacyInfoRaw === "object") {
    const webhook = normalizeString((legacyInfoRaw as any).discord_webhook);
    if (webhook) {
      await store.setDiscordWebhook(webhook);
      importedWebhook = true;
    }
  }

  const existingTasks = await store.listTasks();
  const existingTaskKeys = new Set(
    existingTasks.map((t) =>
      taskKey({
        accountId: t.accountId,
        restaurantId: t.restaurantId,
        partySize: t.partySize,
        startDate: t.startDate,
        endDate: t.endDate,
        startHour: t.startHour,
        endHour: t.endHour,
        delayMs: t.delayMs,
      }),
    ),
  );

  const legacyTasksRaw = await readJsonIfExists(legacyTasksPath);
  if (Array.isArray(legacyTasksRaw)) {
    for (const t of legacyTasksRaw) {
      if (!t || typeof t !== "object") continue;
      const lt = t as LegacyTask;

      const authToken = normalizeString(lt.auth_token);
      const accountName = normalizeAccountName(lt.account_name);
      const account: Account | undefined =
        (authToken ? accountsByAuth.get(authToken) : undefined) ?? (accountName ? accountsByName.get(accountName) : undefined);
      if (!account) continue;

      const restaurantId = normalizeString(lt.restaurant_id);
      const partySize = toInt(lt.party_sz);
      const startDate = normalizeString(lt.start_date);
      const endDate = normalizeString(lt.end_date);
      const startHour = toInt(lt.start_time);
      const endHour = toInt(lt.end_time);
      const delayMs = toInt(lt.delay);

      if (!restaurantId || partySize === undefined || !startDate || !endDate) continue;
      if (startHour === undefined || endHour === undefined || delayMs === undefined) continue;

      const newTask: Omit<Task, "id" | "createdAt" | "updatedAt"> = {
        accountId: account.id,
        restaurantId,
        partySize,
        startDate,
        endDate,
        startHour,
        endHour,
        delayMs,
      };

      const key = taskKey(newTask);
      if (existingTaskKeys.has(key)) continue;

      await store.addTask(newTask);
      existingTaskKeys.add(key);
      importedTasks++;
    }
  }

  return { importedAccounts, importedTasks, importedProxies, importedWebhook };
}


