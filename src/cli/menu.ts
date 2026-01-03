import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { ResyClient } from "../resy/resyClient";
import { Scheduler } from "../scheduler/scheduler";
import type { Account, Schedule, Task } from "../store/schema";
import { LocalStore } from "../store/store";
import { StoreNotifier } from "../notify/storeNotifier";
import { TaskRunner } from "../runner/taskRunner";
import { pickRandom } from "../utils/random";

type MenuChoice =
  | "tasks"
  | "proxies"
  | "info"
  | "accounts"
  | "generateAccounts"
  | "reservations"
  | "startTasks"
  | "scheduleTasks"
  | "manageScheduled"
  | "exit";

const DOW = [
  { name: "Sunday", value: 0 },
  { name: "Monday", value: 1 },
  { name: "Tuesday", value: 2 },
  { name: "Wednesday", value: 3 },
  { name: "Thursday", value: 4 },
  { name: "Friday", value: 5 },
  { name: "Saturday", value: 6 },
] as const;

function parseIntStrict(label: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`Invalid ${label}: "${value}"`);
  return n;
}

function normalizeHHMM(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`Invalid time "${raw}". Expected HH:MM.`);
  const hh = String(Number(m[1])).padStart(2, "0");
  const mm = m[2];
  const hour = Number(hh);
  const minute = Number(mm);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error(`Invalid time "${raw}".`);
  return `${hh}:${mm}`;
}

function nextOnceRunAt(now: Date, hhmm: string): Date {
  const [hh, mm] = hhmm.split(":");
  const hour = Number(hh);
  const minute = Number(mm);
  const runAt = new Date(now);
  runAt.setSeconds(0, 0);
  runAt.setHours(hour, minute, 0, 0);
  if (runAt.getTime() <= now.getTime()) runAt.setDate(runAt.getDate() + 1);
  return runAt;
}

async function pause(message = "Press Enter to continue"): Promise<void> {
  await input({ message, default: "" });
}

function taskLabel(task: Task, account?: Account): string {
  const acc = account ? account.name : task.accountId;
  return `${task.restaurantId} | acct=${acc} | party=${task.partySize} | ${task.startDate}..${task.endDate} | hours ${task.startHour}-${task.endHour} | delay ${task.delayMs}ms`;
}

function scheduleLabel(schedule: Schedule, task?: Task): string {
  const base = task ? task.restaurantId : schedule.taskId;
  if (schedule.kind === "once") return `${base} | once @ ${schedule.runAt ?? "?"} | ${schedule.durationSec}s | ${schedule.enabled ? "enabled" : "disabled"}`;
  if (schedule.kind === "daily") return `${base} | daily @ ${schedule.time ?? "?"} | ${schedule.durationSec}s | ${schedule.enabled ? "enabled" : "disabled"}`;
  return `${base} | weekly @ ${schedule.time ?? "?"} ${schedule.dayOfWeek ?? "?"} | ${schedule.durationSec}s | ${schedule.enabled ? "enabled" : "disabled"}`;
}

export async function runMenu(): Promise<void> {
  const store = new LocalStore();
  const notifier = new StoreNotifier(store);
  const resy = new ResyClient();
  const taskRunner = new TaskRunner(resy, notifier);
  const scheduler = new Scheduler(store, taskRunner);

  await scheduler.start();

  try {
    while (true) {
      console.clear();
      const tasks = await store.listTasks();
      const schedules = await store.listSchedules();
      const running = scheduler.getRunningJobs();

      console.log("ResyBot (TypeScript)");
      console.log(`Data dir: ${store.baseDir}`);
      console.log(`Tasks: ${tasks.length} | Schedules: ${schedules.length} | Running: ${running.length}`);
      console.log("");

      const choice = await select<MenuChoice>({
        message: "Choose an option",
        choices: [
          { name: "1) Show tasks", value: "tasks" },
          { name: "2) Proxies", value: "proxies" },
          { name: "3) Info", value: "info" },
          { name: "4) Manage Accounts", value: "accounts" },
          { name: "5) Generate Accounts (not supported)", value: "generateAccounts" },
          { name: "6) View Reservations", value: "reservations" },
          { name: "7) Start Tasks (run now)", value: "startTasks" },
          { name: "8) Schedule Tasks", value: "scheduleTasks" },
          { name: "9) Manage Scheduled tasks", value: "manageScheduled" },
          { name: "Exit", value: "exit" },
        ],
      });

      if (choice === "tasks") await tasksMenu(store);
      else if (choice === "proxies") await proxiesMenu(store);
      else if (choice === "info") await infoMenu(store);
      else if (choice === "accounts") await accountsMenu(store);
      else if (choice === "generateAccounts") {
        console.log("Account generation/CAPTCHA automation is not included in this TypeScript port.");
        await pause();
      } else if (choice === "reservations") await reservationsMenu(store, resy);
      else if (choice === "startTasks") await startTasksMenu(store, taskRunner);
      else if (choice === "scheduleTasks") {
        await scheduleTasksMenu(store);
        await scheduler.reload();
      } else if (choice === "manageScheduled") {
        await manageScheduledMenu(store, scheduler);
        await scheduler.reload();
      } else if (choice === "exit") return;
    }
  } finally {
    scheduler.stop();
  }
}

async function tasksMenu(store: LocalStore): Promise<void> {
  while (true) {
    console.clear();
    const tasks = await store.listTasks();
    const accounts = await store.listAccounts();
    const accountsById = new Map(accounts.map((a) => [a.id, a] as const));

    console.log("Tasks");
    console.log("");
    if (tasks.length === 0) console.log("(no tasks)");
    for (const [i, t] of tasks.entries()) {
      console.log(`${i + 1}) ${taskLabel(t, accountsById.get(t.accountId))}`);
    }
    console.log("");

    const action = await select<"add" | "delete" | "back">({
      message: "Choose an option",
      choices: [
        { name: "a) Add task", value: "add" },
        { name: "d) Delete task", value: "delete" },
        { name: "Back", value: "back" },
      ],
    });

    if (action === "back") return;
    if (action === "add") {
      if (accounts.length === 0) {
        console.log("No accounts found. Add an account first.");
        await pause();
        continue;
      }

      const selectedAccountIds = await checkbox<string>({
        message: "Select accounts for this task (space to toggle, enter to confirm)",
        choices: accounts.map((a) => ({ name: a.name, value: a.id })),
      });

      if (selectedAccountIds.length === 0) {
        console.log("No accounts selected. Cancelled.");
        await pause();
        continue;
      }

      const restaurantId = (await input({ message: "Restaurant ID", default: "" })).trim();
      const partyRaw = await input({ message: "Party sizes (comma-separated, e.g. 2,3,4)", default: "2" });
      const startDate = (await input({ message: "Start date (YYYY-MM-DD)", default: "" })).trim();
      const endDate = (await input({ message: "End date (YYYY-MM-DD)", default: "" })).trim();
      const startHourRaw = await input({ message: "Start hour (0-23)", default: "18" });
      const endHourRaw = await input({ message: "End hour (0-23)", default: "21" });
      const delayRaw = await input({ message: "Delay between polls (ms)", default: "250" });

      const partySizes = partyRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => parseIntStrict("party size", s))
        .filter((n) => n > 0);

      const startHour = parseIntStrict("start hour", startHourRaw);
      const endHour = parseIntStrict("end hour", endHourRaw);
      const delayMs = parseIntStrict("delay (ms)", delayRaw);

      if (!restaurantId) {
        console.log("Restaurant ID is required.");
        await pause();
        continue;
      }

      if (partySizes.length === 0) {
        console.log("At least one party size is required.");
        await pause();
        continue;
      }

      if (startHour > endHour) {
        console.log("Start hour must be <= end hour.");
        await pause();
        continue;
      }

      const doSave = await confirm({ message: "Save these tasks?", default: true });
      if (!doSave) continue;

      let created = 0;
      for (const accountId of selectedAccountIds) {
        for (const partySize of partySizes) {
          await store.addTask({
            accountId,
            restaurantId,
            partySize,
            startDate,
            endDate,
            startHour,
            endHour,
            delayMs,
          });
          created++;
        }
      }

      console.log(`Saved ${created} task(s).`);
      await pause();
    }

    if (action === "delete") {
      if (tasks.length === 0) {
        await pause("No tasks to delete. Press Enter to continue");
        continue;
      }

      const selectedId = await select<string>({
        message: "Select a task to delete",
        choices: tasks.map((t) => ({
          name: taskLabel(t, accountsById.get(t.accountId)),
          value: t.id,
        })),
      });

      const ok = await confirm({ message: "Delete this task?", default: false });
      if (!ok) continue;

      await store.deleteTask(selectedId);
      console.log("Task deleted.");
      await pause();
    }
  }
}

async function proxiesMenu(store: LocalStore): Promise<void> {
  while (true) {
    console.clear();
    const proxies = await store.listProxies();
    console.log("Proxies");
    console.log("");
    if (proxies.length === 0) console.log("(no proxies)");
    for (const [i, p] of proxies.entries()) console.log(`${i + 1}) ${p}`);
    console.log("");

    const action = await select<"add" | "delete" | "clear" | "back">({
      message: "Choose an option",
      choices: [
        { name: "a) Add proxy", value: "add" },
        { name: "b) Delete proxy", value: "delete" },
        { name: "c) Delete all proxies", value: "clear" },
        { name: "Back", value: "back" },
      ],
    });

    if (action === "back") return;
    if (action === "add") {
      const raw = await input({ message: "Enter proxies (comma-separated) in ip:port:user:pass format", default: "" });
      const list = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0) continue;
      await store.addProxies(list);
      console.log(`Added ${list.length} proxy/proxies.`);
      await pause();
    }
    if (action === "delete") {
      if (proxies.length === 0) {
        await pause("No proxies to delete. Press Enter to continue");
        continue;
      }
      const proxy = await select<string>({
        message: "Select a proxy to delete",
        choices: proxies.map((p) => ({ name: p, value: p })),
      });
      await store.deleteProxy(proxy);
      console.log("Proxy deleted.");
      await pause();
    }
    if (action === "clear") {
      const ok = await confirm({ message: "Delete all proxies?", default: false });
      if (!ok) continue;
      await store.clearProxies();
      console.log("All proxies deleted.");
      await pause();
    }
  }
}

async function infoMenu(store: LocalStore): Promise<void> {
  while (true) {
    console.clear();
    const info = await store.getInfo();
    console.log("Info");
    console.log("");
    console.log(`Discord webhook: ${info.discordWebhook ?? "(not set)"}`);
    console.log("");

    const action = await select<"setWebhook" | "clearWebhook" | "back">({
      message: "Choose an option",
      choices: [
        { name: "Set Discord Webhook", value: "setWebhook" },
        { name: "Clear Discord Webhook", value: "clearWebhook" },
        { name: "Back", value: "back" },
      ],
    });

    if (action === "back") return;
    if (action === "setWebhook") {
      const url = (await input({ message: "Discord Webhook URL", default: info.discordWebhook ?? "" })).trim();
      await store.setDiscordWebhook(url || undefined);
      console.log("Saved.");
      await pause();
    }
    if (action === "clearWebhook") {
      const ok = await confirm({ message: "Clear webhook?", default: false });
      if (!ok) continue;
      await store.setDiscordWebhook(undefined);
      console.log("Cleared.");
      await pause();
    }
  }
}

async function accountsMenu(store: LocalStore): Promise<void> {
  while (true) {
    console.clear();
    const accounts = await store.listAccounts();
    console.log("Accounts");
    console.log("");
    if (accounts.length === 0) console.log("(no accounts)");
    for (const [i, a] of accounts.entries()) console.log(`${i + 1}) ${a.name} | paymentId=${a.paymentId}`);
    console.log("");

    const action = await select<"add" | "delete" | "back">({
      message: "Choose an option",
      choices: [
        { name: "a) Add account", value: "add" },
        { name: "b) Delete account", value: "delete" },
        { name: "Back", value: "back" },
      ],
    });

    if (action === "back") return;
    if (action === "add") {
      const name = (await input({ message: "Account name", default: "" })).trim();
      const authToken = (await input({ message: "Resy Auth Token", default: "" })).trim();
      const paymentIdRaw = (await input({ message: "Resy Payment ID (number)", default: "" })).trim();
      const paymentId = parseIntStrict("payment id", paymentIdRaw);
      await store.addAccount({ name, authToken, paymentId });
      console.log("Account added.");
      await pause();
    }
    if (action === "delete") {
      if (accounts.length === 0) {
        await pause("No accounts to delete. Press Enter to continue");
        continue;
      }
      const accountId = await select<string>({
        message: "Select an account to delete",
        choices: accounts.map((a) => ({ name: a.name, value: a.id })),
      });
      const ok = await confirm({ message: "Delete this account? (Tasks referencing it will break)", default: false });
      if (!ok) continue;
      await store.deleteAccount(accountId);
      console.log("Account deleted.");
      await pause();
    }
  }
}

async function reservationsMenu(store: LocalStore, resy: ResyClient): Promise<void> {
  console.clear();
  console.log("Fetching upcoming reservations...");
  const accounts = await store.listAccounts();
  const proxies = await store.listProxies();

  if (accounts.length === 0) {
    console.log("No accounts found.");
    await pause();
    return;
  }

  type ResRow = {
    accountId: string;
    accountName: string;
    authToken: string;
    resyToken: string;
    venue: string;
    day: string;
    timeSlot: string;
    seats: number;
    link?: string;
    cancelBy?: string;
  };

  const rows: ResRow[] = [];

  for (const acct of accounts) {
    try {
      const proxy = pickRandom(proxies);
      const data = await resy.listUpcomingReservations({
        authToken: acct.authToken,
        ...(proxy ? { proxy } : {}),
      });
      const reservations = data?.reservations;
      const venues = data?.venues;
      if (!Array.isArray(reservations) || !venues || typeof venues !== "object") continue;
      for (const r of reservations) {
        const venueId = String(r?.venue?.id ?? "");
        rows.push({
          accountId: acct.id,
          accountName: acct.name,
          authToken: acct.authToken,
          resyToken: r?.resy_token,
          venue: venues?.[venueId]?.name ?? venueId,
          day: r?.day,
          timeSlot: r?.time_slot,
          seats: r?.num_seats,
          link: r?.share?.link,
          cancelBy: r?.cancellation?.date_refund_cut_off,
        });
      }
    } catch (err) {
      console.log(`Failed to fetch for account ${acct.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.clear();
  console.log("Reservations");
  console.log("");
  if (rows.length === 0) {
    console.log("(none found)");
    await pause();
    return;
  }

  const action = await select<"cancel" | "back">({
    message: "Choose an option",
    choices: [
      { name: "Cancel reservation", value: "cancel" },
      { name: "Back", value: "back" },
    ],
  });
  if (action === "back") return;

  const picked = await select<string>({
    message: "Select a reservation to cancel",
    choices: rows.map((r) => ({
      name: `${r.accountName} | ${r.venue} | ${r.day} ${r.timeSlot} | seats ${r.seats}${r.cancelBy ? ` | cancelBy ${r.cancelBy}` : ""}`,
      value: r.resyToken,
    })),
  });

  const row = rows.find((r) => r.resyToken === picked);
  if (!row) return;

  const ok = await confirm({ message: "Cancel this reservation?", default: false });
  if (!ok) return;

  const proxy = pickRandom(proxies);
  const resp = await resy.cancelReservation({
    authToken: row.authToken,
    resyToken: row.resyToken,
    ...(proxy ? { proxy } : {}),
  });
  console.log(`Cancel response status: ${resp.status}`);
  console.log(JSON.stringify(resp.data, null, 2));
  await pause();
}

async function startTasksMenu(store: LocalStore, taskRunner: TaskRunner): Promise<void> {
  console.clear();
  const tasks = await store.listTasks();
  const accounts = await store.listAccounts();
  const proxies = await store.listProxies();

  if (tasks.length === 0) {
    console.log("No tasks found.");
    await pause();
    return;
  }
  if (accounts.length === 0) {
    console.log("No accounts found.");
    await pause();
    return;
  }

  const durationSec = parseIntStrict("duration seconds", await input({ message: "Run duration (seconds)", default: "10" }));
  const concurrency = parseIntStrict(
    "concurrency",
    await input({ message: "Concurrency (number of tasks at once)", default: String(Math.min(tasks.length, 10)) }),
  );

  console.log(`Running ${tasks.length} task(s) for ~${durationSec}s...`);
  await pause("Press Enter to start");

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), Math.max(1, durationSec * 1000));
  try {
    const results = await taskRunner.runTasksConcurrently({
      tasks,
      accounts,
      proxies,
      signal: abort.signal,
      concurrency,
    });

    console.clear();
    console.log("Run complete. Results:");
    for (const t of tasks) {
      const r = results.get(t.id);
      console.log(`${t.restaurantId} (${t.partySize}) -> ${r?.status ?? "unknown"}`);
    }
    await pause();
  } finally {
    clearTimeout(timeout);
  }
}

async function scheduleTasksMenu(store: LocalStore): Promise<void> {
  console.clear();
  const tasks = await store.listTasks();
  if (tasks.length === 0) {
    console.log("No tasks found. Add a task first.");
    await pause();
    return;
  }

  const accounts = await store.listAccounts();
  const accountsById = new Map(accounts.map((a) => [a.id, a] as const));

  const taskId = await select<string>({
    message: "Select a task to schedule",
    choices: tasks.map((t) => ({ name: taskLabel(t, accountsById.get(t.accountId)), value: t.id })),
  });

  const hhmm = normalizeHHMM(await input({ message: "Enter schedule time (HH:MM)", default: "09:55" }));
  const repeat = await select<"daily" | "weekly" | "once">({
    message: "Repeat schedule?",
    choices: [
      { name: "Daily", value: "daily" },
      { name: "Weekly", value: "weekly" },
      { name: "Once (next occurrence)", value: "once" },
    ],
  });
  const durationSec = parseIntStrict(
    "duration seconds",
    await input({ message: "Task duration in seconds (5-10 recommended)", default: "10" }),
  );

  if (repeat === "daily") {
    await store.addSchedule({
      taskId,
      kind: "daily",
      time: hhmm,
      durationSec,
      enabled: true,
    });
  } else if (repeat === "weekly") {
    const dow = await select<number>({
      message: "Choose day of week",
      choices: DOW.map((d) => ({ name: d.name, value: d.value })),
    });
    await store.addSchedule({
      taskId,
      kind: "weekly",
      time: hhmm,
      dayOfWeek: dow,
      durationSec,
      enabled: true,
    });
  } else {
    const runAt = nextOnceRunAt(new Date(), hhmm).toISOString();
    await store.addSchedule({
      taskId,
      kind: "once",
      runAt,
      durationSec,
      enabled: true,
    });
  }

  console.log("Schedule saved.");
  await pause();
}

async function manageScheduledMenu(store: LocalStore, scheduler: Scheduler): Promise<void> {
  while (true) {
    console.clear();
    const schedules = await store.listSchedules();
    const tasks = await store.listTasks();
    const tasksById = new Map(tasks.map((t) => [t.id, t] as const));
    const running = scheduler.getRunningJobs();

    console.log("Scheduled Tasks");
    console.log("");
    if (schedules.length === 0) console.log("(no scheduled tasks)");
    for (const [i, s] of schedules.entries()) {
      console.log(`${i + 1}) ${scheduleLabel(s, tasksById.get(s.taskId))}`);
    }
    console.log("");
    console.log("Running Tasks");
    console.log("");
    if (running.length === 0) console.log("(none running)");
    for (const [i, r] of running.entries()) {
      const task = tasksById.get(r.taskId);
      console.log(`${i + 1}) runId=${r.runId} | ${task?.restaurantId ?? r.taskId} | started ${r.startedAt} | dur ${r.durationSec}s`);
    }
    console.log("");

    const action = await select<"remove" | "toggle" | "stop" | "back">({
      message: "Choose an action",
      choices: [
        { name: "Remove scheduled task", value: "remove" },
        { name: "Enable/disable scheduled task", value: "toggle" },
        { name: "Stop running task", value: "stop" },
        { name: "Back", value: "back" },
      ],
    });

    if (action === "back") return;

    if (action === "remove") {
      if (schedules.length === 0) {
        await pause("No scheduled tasks to remove. Press Enter to continue");
        continue;
      }
      const id = await select<string>({
        message: "Select a schedule to remove",
        choices: schedules.map((s) => ({ name: scheduleLabel(s, tasksById.get(s.taskId)), value: s.id })),
      });
      const ok = await confirm({ message: "Remove this schedule?", default: false });
      if (!ok) continue;
      await store.deleteSchedule(id);
      console.log("Removed.");
      await pause();
    }

    if (action === "toggle") {
      if (schedules.length === 0) {
        await pause("No scheduled tasks. Press Enter to continue");
        continue;
      }
      const id = await select<string>({
        message: "Select a schedule",
        choices: schedules.map((s) => ({ name: scheduleLabel(s, tasksById.get(s.taskId)), value: s.id })),
      });
      const s = schedules.find((x) => x.id === id);
      if (!s) continue;
      await store.setScheduleEnabled(id, !s.enabled);
      console.log(`Set enabled=${!s.enabled}.`);
      await pause();
    }

    if (action === "stop") {
      if (running.length === 0) {
        await pause("No running tasks to stop. Press Enter to continue");
        continue;
      }
      const runId = await select<string>({
        message: "Select a running task to stop",
        choices: running.map((r) => ({ name: `${r.runId} (${tasksById.get(r.taskId)?.restaurantId ?? r.taskId})`, value: r.runId })),
      });
      const ok = await confirm({ message: "Stop this running task?", default: false });
      if (!ok) continue;
      scheduler.stopRun(runId);
      console.log("Stop signal sent.");
      await pause();
    }
  }
}


