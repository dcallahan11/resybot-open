import type { TaskRunner } from "../runner/taskRunner";
import type { LocalStore } from "../store/store";
import type { Account, Schedule, Task } from "../store/schema";

const MAX_TIMEOUT_MS = 2_147_483_647; // ~24.8 days (setTimeout limit)

function parseHHMM(hhmm: string): { hour: number; minute: number } {
  const [h, m] = hhmm.split(":");
  const hour = Number(h);
  const minute = Number(m);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`Invalid hour in time "${hhmm}"`);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error(`Invalid minute in time "${hhmm}"`);
  return { hour, minute };
}

function nextDailyRun(now: Date, hhmm: string): Date {
  const { hour, minute } = parseHHMM(hhmm);
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function nextWeeklyRun(now: Date, dayOfWeek: number, hhmm: string): Date {
  const { hour, minute } = parseHHMM(hhmm);
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);

  // JS: 0=Sun..6=Sat
  const currentDow = next.getDay();
  let deltaDays = (dayOfWeek - currentDow + 7) % 7;
  if (deltaDays === 0 && next.getTime() <= now.getTime()) deltaDays = 7;
  next.setDate(next.getDate() + deltaDays);
  return next;
}

function computeNextRun(schedule: Schedule, now: Date): Date | undefined {
  if (!schedule.enabled) return undefined;
  if (schedule.kind === "once") {
    if (!schedule.runAt) return undefined;
    const runAt = new Date(schedule.runAt);
    if (Number.isNaN(runAt.getTime())) return undefined;
    return runAt;
  }
  if (schedule.kind === "daily") {
    if (!schedule.time) return undefined;
    return nextDailyRun(now, schedule.time);
  }
  if (schedule.kind === "weekly") {
    if (!schedule.time || schedule.dayOfWeek === undefined) return undefined;
    return nextWeeklyRun(now, schedule.dayOfWeek, schedule.time);
  }
  return undefined;
}

export type RunningJob = {
  runId: string;
  scheduleId: string;
  taskId: string;
  startedAt: string;
  durationSec: number;
};

export class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Map<
    string,
    { meta: RunningJob; abort: AbortController; done: Promise<void> }
  >();

  constructor(
    private readonly store: LocalStore,
    private readonly taskRunner: TaskRunner,
  ) {}

  async start(): Promise<void> {
    await this.reload();
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const r of this.running.values()) r.abort.abort();
  }

  getRunningJobs(): RunningJob[] {
    return Array.from(this.running.values()).map((r) => r.meta);
  }

  stopRun(runId: string): boolean {
    const r = this.running.get(runId);
    if (!r) return false;
    r.abort.abort();
    return true;
  }

  async reload(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const schedules = await this.store.listSchedules();
    for (const s of schedules) {
      this.scheduleNext(s).catch(() => {
        // ignore individual schedule failures; keep runner alive
      });
    }
  }

  private isScheduleRunning(scheduleId: string): boolean {
    for (const { meta } of this.running.values()) {
      if (meta.scheduleId === scheduleId) return true;
    }
    return false;
  }

  private async resolveTaskAndAccounts(taskId: string): Promise<
    | { ok: true; task: Task; accounts: Account[]; proxies: string[] }
    | { ok: false; reason: string }
  > {
    const task = await this.store.getTask(taskId);
    if (!task) return { ok: false, reason: `Task not found: ${taskId}` };
    const account = await this.store.getAccount(task.accountId);
    if (!account) return { ok: false, reason: `Account not found for task.accountId: ${task.accountId}` };
    const backupAccount = task.backupAccountId ? await this.store.getAccount(task.backupAccountId) : undefined;
    const proxies = await this.store.listProxies();
    return { ok: true, task, accounts: backupAccount ? [account, backupAccount] : [account], proxies };
  }

  private async scheduleNext(schedule: Schedule): Promise<void> {
    if (!schedule.enabled) return;

    const now = new Date();
    const nextRun = computeNextRun(schedule, now);
    if (!nextRun) return;

    const delayMs = nextRun.getTime() - now.getTime();
    if (delayMs <= 0) {
      // If the next run is already in the past, fire soon.
      this.fire(schedule.id).catch(() => {});
      return;
    }

    if (delayMs > MAX_TIMEOUT_MS) {
      // Too far out; set a checkpoint timer to re-evaluate later.
      const t = setTimeout(() => {
        this.scheduleNext(schedule).catch(() => {});
      }, MAX_TIMEOUT_MS);
      this.timers.set(schedule.id, t);
      return;
    }

    const t = setTimeout(() => {
      this.fire(schedule.id).catch(() => {});
    }, delayMs);
    this.timers.set(schedule.id, t);
  }

  private async fire(scheduleId: string): Promise<void> {
    const schedule = await this.store.getSchedule(scheduleId);
    if (!schedule || !schedule.enabled) return;

    // Clear existing timer for this schedule before firing.
    const existing = this.timers.get(scheduleId);
    if (existing) clearTimeout(existing);
    this.timers.delete(scheduleId);

    // Reschedule the next run immediately for repeating schedules.
    if (schedule.kind === "daily" || schedule.kind === "weekly") {
      await this.scheduleNext(schedule);
    }

    // Avoid overlapping runs for the same schedule.
    if (this.isScheduleRunning(scheduleId)) return;

    const resolved = await this.resolveTaskAndAccounts(schedule.taskId);
    if (!resolved.ok) return;

    const runId = `${scheduleId}-${Date.now()}`;
    const startedAt = new Date().toISOString();
    const { abortController, promise } = this.taskRunner.startTaskRun({
      task: resolved.task,
      accounts: resolved.accounts,
      proxies: resolved.proxies,
      durationSec: schedule.durationSec,
    });

    const meta: RunningJob = {
      runId,
      scheduleId,
      taskId: schedule.taskId,
      startedAt,
      durationSec: schedule.durationSec,
    };

    const done = promise.finally(() => {
      this.running.delete(runId);
      // Once schedules are one-shot; delete after launching.
      if (schedule.kind === "once") {
        this.store.deleteSchedule(scheduleId).catch(() => {});
      }
    }) as unknown as Promise<void>;

    this.running.set(runId, { meta, abort: abortController, done });
  }
}


