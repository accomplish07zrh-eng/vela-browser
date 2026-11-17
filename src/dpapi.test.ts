import { expect, test } from "bun:test";
import { batchDpapiKeyChecks } from "./dpapi.ts";

test("concurrent cookie key checks share a process and keep their own results", async () => {
  const calls: string[][] = [];
  const check = batchDpapiKeyChecks(async keys => {
    calls.push(keys);
    return keys.map(key => key === "readable");
  });
  expect(await Promise.all([check("readable"), check("unreadable"), check("readable")])).toEqual([true, false, true]);
  expect(calls).toEqual([["readable", "unreadable"]]);
});

test("an incomplete cookie key check resolves without caching a verdict and a later check can retry", async () => {
  let calls = 0;
  const check = batchDpapiKeyChecks(async () => ++calls === 1 ? [] : [true]);
  expect(await check("cookie-key")).toBeUndefined();
  expect(await check("cookie-key")).toBe(true);
});
