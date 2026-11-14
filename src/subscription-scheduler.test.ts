import { afterEach, expect, test } from "bun:test";
import { buildNewProfile } from "./create.ts";
import { ProfileStore } from "./store.ts";
import { SubscriptionError, parseSubscription } from "./subscription.ts";
import { SubscriptionScheduler } from "./subscription-scheduler.ts";

const stores: ProfileStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test("SubscriptionScheduler refreshes only due subscriptions and keeps in-use removed nodes safe", async () => {
  const store = new ProfileStore(":memory:");
  stores.push(store);
  let clock = 10_000_000;
  let version = 1;
  const fetches: string[] = [];

  const subAuto = store.proxyPool.addSubscription({ url: "https://sub.example/auto", refreshHours: 6 });
  const subManual = store.proxyPool.addSubscription({ url: "https://sub.example/manual" });
  const v1 = parseSubscription("vless://11111111-2222-3333-4444-555555555555@jp.example:443?security=tls#JP\nvless://22222222-2222-3333-4444-555555555555@us.example:443?security=tls#US");
  const manualV1 = parseSubscription("vless://33333333-2222-3333-4444-555555555555@sg.example:443?security=tls#SG");
  store.proxyPool.syncSubscription(subAuto.id, v1.nodes, v1);
  store.proxyPool.syncSubscription(subManual.id, manualV1.nodes, manualV1);
  // Simulate last_fetched_at at initial clock (note syncSubscription used Date.now internally, so update timestamps explicitly if needed).
  // Set auto last_fetched_at to 7h ago, manual to 7h ago -> only auto is due.
  const db = (store.proxyPool as any).db;
  db.query(`UPDATE proxy_subscriptions SET last_fetched_at = ?`).run(clock - 7 * 3_600_000);

  const jp = store.proxyPool.list().find((n) => n.subscriptionId === subAuto.id && n.name === "JP")!;
  store.upsertProfile({ ...buildNewProfile({ name: "p1", group: "g", proxy: jp.proxy }, () => false), id: "p1" });

  const scheduler = new SubscriptionScheduler({
    store,
    now: () => clock,
    fetchSubscription: (async (url: string) => {
      fetches.push(url);
      if (version === 2) {
        // US stayed, JP removed from source -> JP stays in pool with removedFromSource: true!
        return { parsed: parseSubscription("vless://22222222-2222-3333-4444-555555555555@us.example:443?security=tls#US") };
      }
      throw new SubscriptionError("network down");
    }) as any,
    log: () => {},
  });

  version = 2;
  expect(await scheduler.tick()).toEqual([subAuto.id]);
  expect(fetches).toEqual(["https://sub.example/auto"]);
  expect(store.proxyPool.get(jp.id)!.removedFromSource).toBe(true);
  // Manual was never fetched automatically.
  expect(store.proxyPool.list().filter((n) => n.subscriptionId === subManual.id && n.removedFromSource)).toEqual([]);

  // Not due again immediately after syncing, and failures preserve lastFetchedAt with retry backoff.
  clock = Date.now() + 1_000;
  expect(await scheduler.tick()).toEqual([]);
  expect(fetches).toHaveLength(1);

  clock = Date.now();
  db.query(`UPDATE proxy_subscriptions SET last_fetched_at = ? WHERE id = ?`).run(clock - 8 * 3_600_000, subAuto.id);
  version = 3;
  expect(await scheduler.tick()).toEqual([]);
  expect(fetches).toHaveLength(2);
  const afterFail = store.proxyPool.getSubscription(subAuto.id)!;
  expect(afterFail.lastError).toBe("network down");
  expect(afterFail.lastFetchedAt).toBeGreaterThan(0);

  // Backed off immediately after failure (clock stays synchronized with ProxyPool Date.now()).
  clock = Date.now() + 1_000;
  expect(await scheduler.tick()).toEqual([]);
  expect(fetches).toHaveLength(2);

  await scheduler.stop();
});
