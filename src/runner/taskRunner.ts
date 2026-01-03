import { ResyClient, ResyHttpError, type ProxyInput } from "../resy/resyClient";
import type { Account, Task } from "../store/schema";
import type { Notifier } from "../notify/discord";
import { pickRandom } from "../utils/random";
import { sleep } from "../utils/sleep";

export type TaskRunResult =
  | { status: "booked"; reservation: any }
  | { status: "failed"; reason: string; details?: any }
  | { status: "aborted" };

function extractTimeFromConfigToken(
  configToken: string,
): { hour: number; minute: number; totalMinutes: number } | undefined {
  // The legacy Python code does: parts = token.split('/'); parts[8].split(':')[0]
  // We prefer a more robust parse: look for "/HH:MM" or "/HH:MM:SS".
  const match = configToken.match(/(?:^|\/)(\d{1,2}):(\d{2})(?::\d{2})?(?:\/|$)/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return { hour, minute, totalMinutes: hour * 60 + minute };
}

function minutesFromHHMM(hhmm: string): number | undefined {
  const match = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return hour * 60 + minute;
}

function hasReservationId(data: any): boolean {
  if (!data || typeof data !== "object") return false;
  if ("reservation_id" in data && data.reservation_id) return true;
  if (data.specs && typeof data.specs === "object" && data.specs.reservation_id) return true;
  return false;
}

export class TaskRunner {
  constructor(
    private readonly resy: ResyClient,
    private readonly notifier: Notifier,
  ) {}

  /**
   * Start a single task run with an internal timeout. The returned AbortController
   * can be used to stop the task early (e.g. from a \"Stop running task\" menu).
   */
  startTaskRun(input: {
    task: Task;
    accounts: Account[];
    proxies: string[];
    durationSec: number;
  }): { abortController: AbortController; promise: Promise<TaskRunResult> } {
    const abortController = new AbortController();
    const timeoutMs = Math.max(1, Math.floor(input.durationSec * 1000));
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    const promise = this.runTaskLoop({
      task: input.task,
      accounts: input.accounts,
      proxies: input.proxies,
      signal: abortController.signal,
    }).finally(() => clearTimeout(timeout));

    return { abortController, promise };
  }

  /**
   * Run many tasks concurrently with a configurable concurrency limit.
   * Each task uses the same abort signal (caller controls cancellation).
   */
  async runTasksConcurrently(input: {
    tasks: Task[];
    accounts: Account[];
    proxies: string[];
    signal: AbortSignal;
    concurrency?: number;
  }): Promise<Map<string, TaskRunResult>> {
    const accountsById = new Map(input.accounts.map((a) => [a.id, a] as const));
    const results = new Map<string, TaskRunResult>();

    const queue = [...input.tasks];
    const concurrency = Math.max(1, Math.floor(input.concurrency ?? (queue.length || 1)));
    const workerCount = Math.min(concurrency, queue.length || 1);

    const worker = async () => {
      while (!input.signal.aborted) {
        const task = queue.shift();
        if (!task) return;
        const primary = accountsById.get(task.accountId);
        if (!primary) {
          results.set(task.id, { status: "failed", reason: `No account found for task.accountId=${task.accountId}` });
          continue;
        }
        const backup = task.backupAccountId ? accountsById.get(task.backupAccountId) : undefined;
        const accounts = backup ? [primary, backup] : [primary];
        const res = await this.runTaskLoop({
          task,
          accounts,
          proxies: input.proxies,
          signal: input.signal,
        });
        results.set(task.id, res);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  async runTaskLoop(input: {
    task: Task;
    accounts: Account[];
    proxies: string[];
    signal: AbortSignal;
  }): Promise<TaskRunResult> {
    const { task, accounts, proxies, signal } = input;
    const primaryAccount = accounts[0];
    if (!primaryAccount) return { status: "failed", reason: "Task has no accounts configured" };

    while (!signal.aborted) {
      const proxyStr = pickRandom(proxies);
      const proxyOpt: { proxy: ProxyInput } | {} = proxyStr ? { proxy: proxyStr } : {};

      try {
        const cal = await this.resy.getVenueCalendar({
          restaurantId: task.restaurantId,
          partySize: task.partySize,
          startDate: task.startDate,
          endDate: task.endDate,
          authToken: primaryAccount.authToken,
          ...proxyOpt,
          signal,
        });

        if (!cal || typeof cal !== "object" || !Array.isArray((cal as any).scheduled)) {
          const msg = `Unexpected /4/venue/calendar response format for restaurant ${task.restaurantId}`;
          await this.notifier.notify(msg);
          return { status: "failed", reason: msg, details: cal };
        }

        for (const entry of (cal as any).scheduled) {
          if (signal.aborted) return { status: "aborted" };
          if (entry?.inventory?.reservation !== "available") continue;

          const day = entry?.date;
          if (typeof day !== "string") continue;

          const found = await this.resy.findSlots({
            restaurantId: task.restaurantId,
            partySize: task.partySize,
            day,
            authToken: primaryAccount.authToken,
            ...proxyOpt,
            signal,
          });

          const slots = found?.results?.venues?.[0]?.slots;
          if (!Array.isArray(slots)) {
            const msg = `Unexpected /4/find response format for restaurant ${task.restaurantId}`;
            await this.notifier.notify(msg);
            return { status: "failed", reason: msg, details: found };
          }

          const desiredMinutes = task.desiredTime ? minutesFromHHMM(task.desiredTime) : undefined;
          const flexMinutes = task.flexMinutes ?? 0;

          const candidates: { slot: any; configToken: string; time: ReturnType<typeof extractTimeFromConfigToken> }[] = [];

          for (const slot of slots) {
            const configToken = slot?.config?.token;
            if (typeof configToken !== "string") continue;
            const time = extractTimeFromConfigToken(configToken);
            if (!time) continue;

            if (desiredMinutes !== undefined) {
              const delta = Math.abs(time.totalMinutes - desiredMinutes);
              if (delta <= flexMinutes) candidates.push({ slot, configToken, time });
            } else {
              if (time.hour >= task.startHour && time.hour <= task.endHour) candidates.push({ slot, configToken, time });
            }
          }

          if (desiredMinutes !== undefined) {
            candidates.sort(
              (a, b) =>
                Math.abs(a.time!.totalMinutes - desiredMinutes) - Math.abs(b.time!.totalMinutes - desiredMinutes),
            );
          }

          for (const c of candidates) {
            if (signal.aborted) return { status: "aborted" };

            // Try accounts in priority order: primary first, then backup.
            for (const acct of accounts) {
              if (signal.aborted) return { status: "aborted" };

              const bookToken = await this.resy.getBookToken({
                day,
                partySize: task.partySize,
                configToken: c.configToken,
                restaurantId: task.restaurantId,
                authToken: acct.authToken,
                ...proxyOpt,
                signal,
              });

              const booked = await this.resy.bookReservation({
                bookToken,
                paymentId: acct.paymentId,
                authToken: acct.authToken,
                ...proxyOpt,
                signal,
              });

              if (hasReservationId(booked.data)) {
                await this.notifier.notify(
                  `Reservation booked: ${task.restaurantName ?? task.restaurantId} | party ${
                    task.partySize
                  } | day ${day} | slot ${String(c.time?.hour).padStart(2, "0")}:${String(c.time?.minute).padStart(
                    2,
                    "0",
                  )} | account ${acct.name}`,
                );
                return { status: "booked", reservation: booked.data };
              }
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return { status: "aborted" };
        if (err instanceof ResyHttpError) {
          const msg = `Resy HTTP error for restaurant ${task.restaurantId}: ${err.status} ${err.url} - ${err.bodyText.slice(
            0,
            500,
          )}`;
          await this.notifier.notify(msg);
          return { status: "failed", reason: msg };
        }
        const msg = `Unexpected error executing task for restaurant ${task.restaurantId}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        await this.notifier.notify(msg);
        return { status: "failed", reason: msg };
      }

      try {
        await sleep(task.delayMs, signal);
      } catch {
        return { status: "aborted" };
      }
    }

    return { status: "aborted" };
  }
}


