#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { runMenu } from "./cli/menu";
import { runRunner } from "./runner/runnerMain";

const program = new Command();

program
  .name("resybot")
  .description("ResyBot (TypeScript): schedule and execute reservation tasks")
  .version("0.1.0");

program
  .command("menu")
  .description("Start the interactive menu")
  .action(async () => {
    await runMenu();
  });

program
  .command("runner")
  .description("Start the scheduler runner (loads persisted schedules and waits)")
  .action(async () => {
    await runRunner();
  });

program
  .command("import-legacy")
  .description("Import tasks/accounts/proxies/info from the legacy Python client JSON directory")
  .option("--from <dir>", "Legacy data directory", "legacy-python/client")
  .action(async (opts: { from: string }) => {
    const { LocalStore } = await import("./store/store");
    const { importLegacyPythonData } = await import("./migrate/importLegacy");
    const store = new LocalStore();
    const res = await importLegacyPythonData({ store, legacyDir: opts.from });
    console.log(JSON.stringify(res, null, 2));
    console.log(`Data dir: ${store.baseDir}`);
  });

program
  .command("apply-config")
  .description("Apply resybot.config.json (accounts + reservations) into the data/ store")
  .option("--file <path>", "Path to config file", "resybot.config.json")
  .action(async (opts: { file: string }) => {
    const { LocalStore } = await import("./store/store");
    const { applyBotConfig } = await import("./config/applyConfig");
    const store = new LocalStore();
    const result = await applyBotConfig({ store, configPath: opts.file });
    console.log(JSON.stringify(result, null, 2));
  });

function todayLocalYYYYMMDD(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

program
  .command("west-village-top-rated")
  .description("Print West Village (NYC) venue names with rating > 4.5 from Resy venue search")
  .option("--min-rating <n>", "Minimum rating (0-5)", "4.5")
  .option("--radius-m <n>", "Search radius in meters around West Village center", "2000")
  .option("--day <yyyy-mm-dd>", "Day used for Resy availability context", todayLocalYYYYMMDD())
  .option("--party-size <n>", "Party size used for Resy availability context", "2")
  .option("--out <file>", "Write names to a file (one per line)")
  .option("--out-json <file>", "Write JSON (includes venue id + rating) to a file")
  .action(
    async (opts: { minRating: string; radiusM: string; day: string; partySize: string; out?: string; outJson?: string }) => {
      const { runWestVillageTopRated } = await import("./scripts/westVillageTopRated");
      const rows = await runWestVillageTopRated({
        minRating: Number(opts.minRating),
        radiusMeters: Number(opts.radiusM),
        day: opts.day,
        partySize: Number(opts.partySize),
        ...(opts.out ? { outFile: opts.out } : {}),
        ...(opts.outJson ? { outJsonFile: opts.outJson } : {}),
      });
      for (const r of rows) console.log(r.name);
    },
  );

program
  .command("generate-weekend-reservations")
  .description("Generate a starter reservations list (Fri/Sat only) from a venues JSON file")
  .option("--venues <file>", "Venues JSON file", "west-village-top-rated-4.5.json")
  .option("--count <n>", "How many restaurants to include (must fit into unique Fri/Sat dates)", "8")
  .option("--start-date <yyyy-mm-dd>", "Start date for finding Fri/Sat dates (defaults to today)")
  .option("--party-size <n>", "Party size", "2")
  .option("--time <hh:mm>", "Desired time (use 20:15 + flex 45 for 7:30–9:00pm)", "20:15")
  .option("--flex-minutes <n>", "Flex minutes around desired time", "45")
  .option("--poll-delay-ms <n>", "Polling delay in ms", "250")
  .option("--out <file>", "Output file", "weekend-reservations.generated.json")
  .action(
    async (opts: {
      venues: string;
      count: string;
      startDate?: string;
      partySize: string;
      time: string;
      flexMinutes: string;
      pollDelayMs: string;
      out: string;
    }) => {
      const { generateWeekendReservations } = await import("./scripts/generateWeekendReservations");
      const res = await generateWeekendReservations({
        venuesFile: opts.venues,
        count: Number(opts.count),
        ...(opts.startDate ? { startDate: opts.startDate } : {}),
        partySize: Number(opts.partySize),
        time: opts.time,
        flexMinutes: Number(opts.flexMinutes),
        pollDelayMs: Number(opts.pollDelayMs),
        outFile: opts.out,
      });
      console.log(JSON.stringify({ outFile: res.outFile, count: res.reservations.length }, null, 2));
    },
  );

program
  .command("merge-reservations")
  .description("Merge a generated reservations JSON array into resybot.config.json")
  .option("--config <file>", "Config file", "resybot.config.json")
  .option("--reservations <file>", "Reservations JSON file", "weekend-reservations.generated.json")
  .option("--mode <append|replace>", "Append or replace config.reservations", "append")
  .action(async (opts: { config: string; reservations: string; mode: "append" | "replace" }) => {
    const { mergeReservationsIntoConfig } = await import("./scripts/mergeReservationsIntoConfig");
    const res = await mergeReservationsIntoConfig({
      configFile: opts.config,
      reservationsFile: opts.reservations,
      mode: opts.mode === "replace" ? "replace" : "append",
    });
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command("monitor-west-village-release")
  .description("Poll West Village venues slowly and record when booking windows advance (helps infer release time-of-day)")
  .option("--min-rating <n>", "Minimum rating", "4.5")
  .option("--radius-m <n>", "Radius (meters)", "2000")
  .option("--interval-sec <n>", "Polling interval seconds (keep this >= 60 to avoid rate limiting)", "120")
  .option("--duration-min <n>", "How long to run (minutes)", "30")
  .option("--state <file>", "State file (stores last max date + events)", "data/west-village-release-monitor.json")
  .action(
    async (opts: {
      minRating: string;
      radiusM: string;
      intervalSec: string;
      durationMin: string;
      state: string;
    }) => {
      const { monitorWestVillageRelease } = await import("./scripts/monitorWestVillageRelease");
      const res = await monitorWestVillageRelease({
        minRating: Number(opts.minRating),
        radiusMeters: Number(opts.radiusM),
        intervalSec: Number(opts.intervalSec),
        durationMin: Number(opts.durationMin),
        stateFile: opts.state,
      });
      console.log(JSON.stringify(res, null, 2));
    },
  );

program
  .command("scrape-release-policies")
  .description("Scrape per-venue booking window + exact release time-of-day (from venue 'Need to know' text)")
  .option("--venues <file>", "Venues JSON file (from west-village-top-rated --out-json)", "west-village-top-rated-4.5.json")
  .option("--location <slug>", "Resy location slug", "new-york-ny")
  .option("--start <n>", "Start index into venues array (0-based)", "0")
  .option("--limit <n>", "Max number of venues to process in this run", "25")
  .option("--delay-ms <ms>", "Delay between venues in milliseconds (rate limiting)", "400")
  .option("--timezone <iana>", "Timezone for releaseTimeLocal (default America/New_York)", "America/New_York")
  .option("--out <file>", "Output JSON file", "venue-release-policies.json")
  .option("--force", "Re-scrape even if the venue already exists in the output file")
  .action(
    async (opts: {
      venues: string;
      location: string;
      start: string;
      limit: string;
      delayMs: string;
      timezone: string;
      out: string;
      force?: boolean;
    }) => {
      const { scrapeVenueReleasePolicies } = await import("./scripts/scrapeVenueReleasePolicies");
      const res = await scrapeVenueReleasePolicies({
        venuesFile: opts.venues,
        locationSlug: opts.location,
        start: Number(opts.start),
        limit: Number(opts.limit),
        delayMs: Number(opts.delayMs),
        outFile: opts.out,
        timezone: opts.timezone,
        force: Boolean(opts.force),
      });
      console.log(JSON.stringify(res, null, 2));
    },
  );

program
  .command("enrich-venues-metadata")
  .description("Enrich a venues JSON file with full venue/config metadata (cached to data/) + extracted release policy")
  .option("--venues <file>", "Venues JSON file (array)", "west-village-top-rated-4.5.json")
  .option("--out <file>", "Output file (defaults to in-place update)", "")
  .option("--location <slug>", "Resy location slug", "new-york-ny")
  .option("--timezone <iana>", "Timezone label for parsed release times", "America/New_York")
  .option("--cache-dir <dir>", "Directory to write raw per-venue JSON payloads", "data/venue-meta")
  .option("--write-raw <true|false>", "Write raw /3/venue + /2/config JSON files", "true")
  .option("--start <n>", "Start index into venues array (0-based)", "0")
  .option("--limit <n>", "Max number of venues to process in this run", "25")
  .option("--delay-ms <ms>", "Delay between venues in milliseconds (rate limiting)", "600")
  .option("--force", "Re-enrich even if a venue already has meta")
  .action(
    async (opts: {
      venues: string;
      out: string;
      location: string;
      timezone: string;
      cacheDir: string;
      writeRaw: string;
      start: string;
      limit: string;
      delayMs: string;
      force?: boolean;
    }) => {
      const { enrichVenuesMetadata } = await import("./scripts/enrichVenuesMetadata");
      const outFile = opts.out && opts.out.trim().length > 0 ? opts.out : undefined;
      const res = await enrichVenuesMetadata({
        venuesFile: opts.venues,
        ...(outFile ? { outFile } : {}),
        locationSlug: opts.location,
        timezone: opts.timezone,
        cacheDir: opts.cacheDir,
        writeRaw: opts.writeRaw.toLowerCase() !== "false",
        start: Number(opts.start),
        limit: Number(opts.limit),
        delayMs: Number(opts.delayMs),
        force: Boolean(opts.force),
      });
      console.log(JSON.stringify(res, null, 2));
    },
  );

const locationCmd = program.command("location").description("Location workspace workflow (discover → enrich → review → run)");

locationCmd
  .command("init")
  .description("Create a location workspace from a place string (geocode → discover venues → enrich/cache → write report)")
  .requiredOption("--place <text>", "Place string to geocode (e.g. \"West Village, New York, NY\")")
  .option("--key <key>", "Location key (folder name). Defaults to a slug of the place string.")
  .option("--base-dir <dir>", "Base directory for location workspaces", "data/locations")
  .option("--force-geocode", "Force re-geocoding even if cached", false)
  .option("--radius-m <n>", "Search radius in meters", "2000")
  .option("--min-rating <n>", "Minimum rating (0-5)", "4.5")
  .option("--min-rating-count <n>", "Minimum rating count (filter out low-sample venues)", "50")
  .option("--query <q>", "Optional Resy search query (defaults to empty)", "")
  .option("--neighborhood-contains <text>", "Optional neighborhood substring filter (case-insensitive)", "")
  .option("--day <yyyy-mm-dd>", "Day used for Resy availability context", todayLocalYYYYMMDD())
  .option("--party-size <n>", "Party size used for Resy availability context", "2")
  .option("--auto-enable-top <n>", "How many top venues to enable by default", "15")
  .option("--enrich-delay-ms <ms>", "Delay between venue enrich calls (rate limiting)", "650")
  .option("--skip-enrich", "Skip enrichment/caching (discovery only)", false)
  .action(
    async (opts: {
      place: string;
      key?: string;
      baseDir: string;
      forceGeocode?: boolean;
      radiusM: string;
      minRating: string;
      minRatingCount: string;
      query: string;
      neighborhoodContains: string;
      day: string;
      partySize: string;
      autoEnableTop: string;
      enrichDelayMs: string;
      skipEnrich?: boolean;
    }) => {
      const { locationInit } = await import("./scripts/locationInit");
      const res = await locationInit({
        place: opts.place,
        ...(opts.key ? { locationKey: opts.key } : {}),
        baseDir: opts.baseDir,
        forceGeocode: Boolean(opts.forceGeocode),
        radiusMeters: Number(opts.radiusM),
        minRating: Number(opts.minRating),
        minRatingCount: Number(opts.minRatingCount),
        query: opts.query,
        ...(opts.neighborhoodContains.trim().length ? { neighborhoodContains: opts.neighborhoodContains } : {}),
        day: opts.day,
        partySize: Number(opts.partySize),
        autoEnableTop: Number(opts.autoEnableTop),
        enrichDelayMs: Number(opts.enrichDelayMs),
        skipEnrich: Boolean(opts.skipEnrich),
      });
      console.log(JSON.stringify(res, null, 2));
    },
  );

locationCmd
  .command("start")
  .description("Generate reservations + schedules from enabled venues, merge into config, apply, and optionally start runner")
  .requiredOption("--location <key>", "Location key (folder name under base-dir)")
  .option("--base-dir <dir>", "Base directory for location workspaces", "data/locations")
  .option("--config <file>", "Config file to merge into", "resybot.config.json")
  .option("--mode <append|replace>", "Append or replace config.reservations", "replace")
  .option("--start-date <yyyy-mm-dd>", "Start date for finding Fri/Sat dining dates (defaults to today)")
  .option("--party-size <n>", "Party size", "2")
  .option("--time <hh:mm>", "Desired dining time (e.g. 20:15)", "20:15")
  .option("--flex-minutes <n>", "Flex minutes around desired time", "45")
  .option("--poll-delay-ms <n>", "Polling delay in ms", "250")
  .option("--default-release-time <hh:mm>", "Fallback release time if venue has no explicit one", "09:00")
  .option("--unknown-release <default|skip>", "If release policy is unknown, default behavior", "default")
  .option("--start-early-sec <n>", "Start polling this many seconds before the release time", "10")
  .option("--duration-sec <n>", "How long to run the task when it fires", "120")
  .option("--no-apply", "Do not apply config into data/ store (just generate + merge)")
  .option("--run", "Start runner after apply-config (blocks)", false)
  .action(
    async (opts: {
      location: string;
      baseDir: string;
      config: string;
      mode: "append" | "replace";
      startDate?: string;
      partySize: string;
      time: string;
      flexMinutes: string;
      pollDelayMs: string;
      defaultReleaseTime: string;
      unknownRelease: "default" | "skip";
      startEarlySec: string;
      durationSec: string;
      apply: boolean;
      run?: boolean;
    }) => {
      const { locationStart } = await import("./scripts/locationStart");
      const locationDir = path.join(opts.baseDir, opts.location);
      const res = await locationStart({
        locationDir,
        configFile: opts.config,
        mode: opts.mode === "append" ? "append" : "replace",
        ...(opts.startDate ? { startDate: opts.startDate } : {}),
        partySize: Number(opts.partySize),
        time: opts.time,
        flexMinutes: Number(opts.flexMinutes),
        pollDelayMs: Number(opts.pollDelayMs),
        defaultReleaseTime: opts.defaultReleaseTime,
        unknownReleaseMode: opts.unknownRelease === "skip" ? "skip" : "default",
        startEarlySec: Number(opts.startEarlySec),
        durationSec: Number(opts.durationSec),
        apply: Boolean(opts.apply),
        runRunner: Boolean(opts.run),
      });
      console.log(JSON.stringify(res, null, 2));
    },
  );

const accountsCmd = program.command("accounts").description("Manage accounts");
accountsCmd
  .command("list")
  .description("List accounts")
  .action(async () => {
    const { LocalStore } = await import("./store/store");
    const store = new LocalStore();
    const accounts = await store.listAccounts();
    console.log(JSON.stringify(accounts, null, 2));
  });

accountsCmd
  .command("add")
  .description("Add an account")
  .requiredOption("--name <name>", "Account name")
  .requiredOption("--auth-token <token>", "Resy auth token")
  .requiredOption("--payment-id <id>", "Resy payment id (number)")
  .action(async (opts: { name: string; authToken: string; paymentId: string }) => {
    const { LocalStore } = await import("./store/store");
    const store = new LocalStore();
    const paymentId = Number(opts.paymentId);
    if (!Number.isInteger(paymentId) || paymentId < 0) throw new Error("payment-id must be a non-negative integer");
    const account = await store.addAccount({ name: opts.name, authToken: opts.authToken, paymentId });
    console.log(JSON.stringify(account, null, 2));
  });

accountsCmd
  .command("delete")
  .description("Delete an account by id")
  .requiredOption("--id <id>", "Account id (uuid)")
  .action(async (opts: { id: string }) => {
    const { LocalStore } = await import("./store/store");
    const store = new LocalStore();
    const ok = await store.deleteAccount(opts.id);
    console.log(ok ? "Deleted." : "Not found.");
  });

const tasksCmd = program.command("tasks").description("Manage tasks");
tasksCmd
  .command("list")
  .description("List tasks")
  .action(async () => {
    const { LocalStore } = await import("./store/store");
    const store = new LocalStore();
    const tasks = await store.listTasks();
    console.log(JSON.stringify(tasks, null, 2));
  });

tasksCmd
  .command("add")
  .description("Add a task")
  .requiredOption("--account-id <id>", "Account id (uuid)")
  .requiredOption("--restaurant-id <id>", "Restaurant/venue id")
  .requiredOption("--party-size <n>", "Party size")
  .requiredOption("--start-date <yyyy-mm-dd>", "Start date")
  .requiredOption("--end-date <yyyy-mm-dd>", "End date")
  .requiredOption("--start-hour <h>", "Start hour (0-23)")
  .requiredOption("--end-hour <h>", "End hour (0-23)")
  .requiredOption("--delay-ms <ms>", "Delay between polls")
  .action(
    async (opts: {
      accountId: string;
      restaurantId: string;
      partySize: string;
      startDate: string;
      endDate: string;
      startHour: string;
      endHour: string;
      delayMs: string;
    }) => {
      const { LocalStore } = await import("./store/store");
      const store = new LocalStore();
      const task = await store.addTask({
        accountId: opts.accountId,
        restaurantId: opts.restaurantId,
        partySize: Number(opts.partySize),
        startDate: opts.startDate,
        endDate: opts.endDate,
        startHour: Number(opts.startHour),
        endHour: Number(opts.endHour),
        delayMs: Number(opts.delayMs),
      });
      console.log(JSON.stringify(task, null, 2));
    },
  );

tasksCmd
  .command("delete")
  .description("Delete a task by id")
  .requiredOption("--id <id>", "Task id (uuid)")
  .action(async (opts: { id: string }) => {
    const { LocalStore } = await import("./store/store");
    const store = new LocalStore();
    const ok = await store.deleteTask(opts.id);
    console.log(ok ? "Deleted." : "Not found.");
  });

const schedulesCmd = program.command("schedules").description("Manage schedules");
schedulesCmd
  .command("list")
  .description("List schedules")
  .action(async () => {
    const { LocalStore } = await import("./store/store");
    const store = new LocalStore();
    const schedules = await store.listSchedules();
    console.log(JSON.stringify(schedules, null, 2));
  });

schedulesCmd
  .command("delete")
  .description("Delete a schedule by id")
  .requiredOption("--id <id>", "Schedule id (uuid)")
  .action(async (opts: { id: string }) => {
    const { LocalStore } = await import("./store/store");
    const store = new LocalStore();
    const ok = await store.deleteSchedule(opts.id);
    console.log(ok ? "Deleted." : "Not found.");
  });

await program.parseAsync(process.argv);


