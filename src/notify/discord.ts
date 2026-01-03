import { fetch } from "undici";

export interface Notifier {
  notify(message: string): Promise<void>;
}

export class DiscordNotifier implements Notifier {
  constructor(private readonly webhookUrl?: string) {}

  async notify(message: string): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
    } catch {
      // Best-effort: notifications should never crash the runner.
    }
  }
}


