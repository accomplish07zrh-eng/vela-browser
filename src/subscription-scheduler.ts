import { refreshPoolSubscription } from "./proxy-pool-api.ts";
import type { ProfileStore } from "./store.ts";
import type { fetchSubscription } from "./subscription.ts";

export interface SubscriptionSchedulerDeps {
  store: ProfileStore;
  fetchSubscription?: typeof fetchSubscription;
  now?: () => number;
  log?: (msg: string) => void;
}

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_INITIAL_DELAY_MS = 5_000;

/**
 * Periodically refreshes proxy subscriptions whose configured `refreshHours` interval has elapsed.
 * Each refresh goes through `refreshPoolSubscription` so manual refreshes and scheduled ticks share
 * in-flight work, keep removed in-use nodes intact, and avoid overlapping sync writes.
 */
export class SubscriptionScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private initialTimer?: ReturnType<typeof setTimeout>;
  private abortController?: AbortController;
  private activeTick?: Promise<string[]>;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: SubscriptionSchedulerDeps) {}

  start(intervalMs = DEFAULT_CHECK_INTERVAL_MS, initialDelayMs = DEFAULT_INITIAL_DELAY_MS): void {
    if (this.stopped || this.timer || this.initialTimer) return;
    const run = () => { void this.tick().catch(() => {}); };
    if (initialDelayMs > 0) {
      this.initialTimer = setTimeout(() => {
        this.initialTimer = undefined;
        if (!this.stopped) run();
      }, initialDelayMs);
      (this.initialTimer as { unref?: () => void }).unref?.();
    } else {
      run();
    }
    this.timer = setInterval(run, intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.initialTimer);
    this.initialTimer = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    this.abortController?.abort();
    await this.activeTick?.catch(() => {});
  }

  /** Run one due-check pass. Returns ids of subscriptions whose refresh succeeded. */
  tick(): Promise<string[]> {
    if (this.stopped || this.running) return Promise.resolve([]);
    this.running = true;
    const controller = new AbortController();
    this.abortController = controller;
    let pass: Promise<string[]> | undefined;
    pass = (async (): Promise<string[]> => {
      const refreshed: string[] = [];
      try {
        const now = (this.deps.now ?? Date.now)();
        let due;
        try {
          due = this.deps.store.proxyPool.listDueSubscriptions(now);
        } catch {
          return [];
        }
        for (const sub of due) {
          if (this.stopped || controller.signal.aborted) break;
          const current = this.deps.store.proxyPool.getSubscription(sub.id);
          if (!current || current.refreshHours === null || current.unreadable) continue;
          try {
            await refreshPoolSubscription(this.deps.store, sub.id, {
              ...(this.deps.fetchSubscription ? { fetchSubscription: this.deps.fetchSubscription } : {}),
              signal: controller.signal,
            });
            if (!this.stopped && !controller.signal.aborted) refreshed.push(sub.id);
          } catch (error) {
            if (this.stopped || controller.signal.aborted) break;
            const reason = error instanceof Error ? error.message : String(error);
            this.deps.log?.(`scheduled subscription refresh failed (${sub.name}): ${reason}`);
          }
        }
        return refreshed;
      } finally {
        if (this.abortController === controller) this.abortController = undefined;
        this.running = false;
        if (this.activeTick === pass) this.activeTick = undefined;
      }
    })();
    this.activeTick = pass;
    return pass;
  }
}
