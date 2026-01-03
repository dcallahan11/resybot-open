export async function runRunner(): Promise<void> {
  const { LocalStore } = await import("../store/store");
  const { ResyClient } = await import("../resy/resyClient");
  const { StoreNotifier } = await import("../notify/storeNotifier");
  const { TaskRunner } = await import("./taskRunner");
  const { Scheduler } = await import("../scheduler/scheduler");

  const store = new LocalStore();
  const notifier = new StoreNotifier(store);
  const resy = new ResyClient();
  const taskRunner = new TaskRunner(resy, notifier);
  const scheduler = new Scheduler(store, taskRunner);

  await scheduler.start();

  console.log(`Scheduler started. Data dir: ${store.baseDir}`);
  console.log("Press Ctrl+C to stop.");

  const shutdown = () => {
    console.log("Shutting down...");
    scheduler.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive
  await new Promise(() => {});
}


