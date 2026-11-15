import { expect, test } from "bun:test";
import { fetchDirectEgress, parseEgressResponse, resolveEgressEndpoints } from "./egress.ts";

test("parseEgressResponse accepts JSON and plain IPv4/IPv6 responses", () => {
  expect(parseEgressResponse('{"ip":"203.0.113.4","country":"US","timezone":"America/New_York"}')).toEqual({
    ip: "203.0.113.4",
    country: "US",
    timezone: "America/New_York",
  });
  expect(parseEgressResponse('{"ip":"203.0.113.4","timezone":"Invalid/Zone"}')).toEqual({ ip: "203.0.113.4" });
  expect(parseEgressResponse('{"query":"2001:db8::1"}')).toEqual({ ip: "2001:db8::1" });
  expect(parseEgressResponse("198.51.100.9\n")).toEqual({ ip: "198.51.100.9" });
});

test("parseEgressResponse rejects malformed responses", () => {
  expect(parseEgressResponse("")).toBeNull();
  expect(parseEgressResponse("not an ip")).toBeNull();
  expect(parseEgressResponse('{"ip":"localhost"}')).toBeNull();
});

test("egress endpoints support an operator override and reject invalid schemes", () => {
  expect(resolveEgressEndpoints("https://one.example/ip, http://127.0.0.1:8080/ip")).toEqual([
    "https://one.example/ip",
    "http://127.0.0.1:8080/ip",
  ]);
  expect(() => resolveEgressEndpoints("")).toThrow("at least one URL");
  expect(() => resolveEgressEndpoints("file:///tmp/ip")).toThrow("must use http or https");
});

test("direct egress reports request and service failures without exposing raw errors", async () => {
  const seen: string[] = [];
  const failures: string[] = [];
  const info = await fetchDirectEgress({
    endpoints: ["https://one.test/ip", "https://two.test/ip"],
  }, (async (endpoint: string) => {
    seen.push(endpoint);
    if (endpoint.includes("one")) throw new Error("unavailable");
    return new Response('{"ip":"198.51.100.7"}');
  }) as typeof fetch, (failure) => failures.push(failure));

  expect(info).toEqual({ ip: "198.51.100.7" });
  expect(seen).toEqual(["https://one.test/ip", "https://two.test/ip"]);
  expect(failures).toEqual(["request_failed"]);

  await expect(fetchDirectEgress({ endpoints: ["https://one.test/ip"] },
    (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
    (failure) => failures.push(failure),
  )).resolves.toBeNull();
  expect(failures).toEqual(["request_failed", "service_failed"]);

  await expect(fetchDirectEgress({ endpoints: ["http://one.test/ip"] },
    (async () => new Response("proxy authentication required", { status: 407 })) as unknown as typeof fetch,
    (failure) => failures.push(failure),
  )).resolves.toBeNull();
  expect(failures).toEqual([
    "request_failed",
    "service_failed",
    "proxy_authentication_failed",
  ]);
});

test("answers from ip.sb and ipwho.is are read with their country code and timezone", async () => {
  const { parseEgressResponse } = await import("./egress.ts");
  expect(parseEgressResponse(JSON.stringify({ ip: "60.157.123.234", country: "Japan", country_code: "JP", timezone: "Asia/Tokyo", isp: "SoftBank Corp." })))
    .toMatchObject({ ip: "60.157.123.234", country: "JP", timezone: "Asia/Tokyo", org: "SoftBank Corp." });
  expect(parseEgressResponse(JSON.stringify({ ip: "60.157.123.234", success: true, country: "Japan", country_code: "JP", timezone: { id: "Asia/Tokyo" }, connection: { isp: "SoftBank" } })))
    .toMatchObject({ country: "JP", timezone: "Asia/Tokyo", org: "SoftBank" });
  expect(parseEgressResponse("60.157.123.234\n")).toEqual({ ip: "60.157.123.234" });
});
