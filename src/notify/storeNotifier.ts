import type { LocalStore } from "../store/store";
import { DiscordNotifier, type Notifier } from "./discord";

/**
 * A notifier that reads the latest webhook from the LocalStore on each call.
 * This lets long-running processes pick up webhook changes without restart.
 */
export class StoreNotifier implements Notifier {
  constructor(private readonly store: LocalStore) {}

  async notify(message: string): Promise<void> {
    const info = await this.store.getInfo();
    const notifier = new DiscordNotifier(info.discordWebhook);
    await notifier.notify(message);
  }
}


