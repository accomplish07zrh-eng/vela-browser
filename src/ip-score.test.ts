import { expect, test } from "bun:test";
import { IP_SOURCES, IpScoreCache, scoreIp, scoreVerdicts, type SourceVerdict } from "./ip-score.ts";

const verdict = (id: string, extra: Partial<SourceVerdict> = {}): SourceVerdict => ({ id, name: id, ok: true, country: "JP", timezone: "Asia/Tokyo", flags: [], ...extra });

test("a clean home line scores 100, a flagged datacenter proxy scores low, with the services named", () => {
  const clean = scoreVerdicts("60.157.123.234", ["a", "b", "c", "d"].map((id) => verdict(id)));
  expect(clean).toMatchObject({ score: 100, grade: "clean", kind: "residential", country: "JP" });
  expect(clean.findings.map((finding) => finding.id)).toEqual(["clean"]);
  const flagged = scoreVerdicts("217.142.255.161", [
    verdict("proxycheck", { flags: ["vpn"], risk: 66 }), verdict("ip-api", { flags: ["proxy", "hosting"] }),
    verdict("ipquery", { flags: ["hosting"] }), verdict("ip2location", { flags: ["proxy"] }), verdict("ipinfo"),
  ]);
  expect(flagged).toMatchObject({ grade: "poor", kind: "hosting" });
  // 100 - 35 (three services see a proxy) - 30 (two see a datacenter) - 17 (risk 66) = 18
  expect(flagged.score).toBe(18);
  expect(flagged.findings.find((finding) => finding.id === "proxy")?.params?.sources).toBe("proxycheck, ip-api, ip2location");
});

test("one database placing an IP elsewhere is a note; several cost points; Tor and abuse weigh most", () => {
  const outlier = scoreVerdicts("1.2.3.4", [verdict("a"), verdict("b"), verdict("c", { country: "US", timezone: "America/Chicago" })]);
  expect(outlier.findings.map((finding) => finding.id)).toContain("country-outlier");
  expect(outlier.score).toBe(95);
  const split = scoreVerdicts("1.2.3.4", [verdict("a"), verdict("b"), verdict("c", { country: "US" }), verdict("d", { country: "DE" })]);
  expect(split.findings.map((finding) => finding.id)).toContain("country");
  expect(scoreVerdicts("1.2.3.4", [verdict("a", { flags: ["tor"] }), verdict("b"), verdict("c")]).score).toBe(40);
  expect(scoreVerdicts("1.2.3.4", [verdict("a", { flags: ["mobile"] }), verdict("b"), verdict("c")]).kind).toBe("mobile");
});

test("every service is asked once; failures are skipped; private addresses are refused; scores are cached", async () => {
  const asked: string[] = [];
  const fetchFn = async (url: string) => {
    asked.push(url);
    if (url.includes("ipinfo")) return new Response("busy", { status: 429 });
    if (url.includes("ip-api")) return Response.json({ status: "success", countryCode: "JP", timezone: "Asia/Tokyo", isp: "X", proxy: false, hosting: false, mobile: false });
    return Response.json({ country_code: "JP" });
  };
  const result = await scoreIp("60.157.123.234", fetchFn);
  expect(asked.length).toBe(IP_SOURCES.length);
  expect(result.sources.find((source) => source.id === "ipinfo")?.ok).toBe(false);
  expect(result.answered).toBe(IP_SOURCES.length - 1);
  await expect(scoreIp("192.168.0.5", fetchFn)).rejects.toThrow("private");
  await expect(scoreIp("198.18.0.1", fetchFn)).rejects.toThrow("private");
  const cache = new IpScoreCache(undefined, fetchFn);
  asked.length = 0;
  await cache.score("60.157.123.234"); await cache.score("60.157.123.234");
  expect(asked.length).toBe(IP_SOURCES.length);
});

test("each service's answer is read into the same verdict", () => {
  const parse = (id: string, body: unknown, ip = "1.2.3.4") => IP_SOURCES.find((source) => source.id === id)!.parse(body, ip);
  expect(parse("proxycheck", { "1.2.3.4": { proxy: "yes", type: "VPN", risk: 66, isocode: "JP" } })).toMatchObject({ flags: ["vpn"], risk: 66, country: "JP" });
  expect(parse("ipquery", { risk: { is_datacenter: true, is_vpn: false, risk_score: 10 }, location: { country_code: "jp" } })).toMatchObject({ flags: ["hosting"], risk: 10, country: "JP" });
  expect(parse("iplocate", { privacy: { is_hosting: true, is_abuser: true }, asn: { type: "hosting" }, country_code: "JP" })).toMatchObject({ flags: ["hosting", "abuser"], network: "hosting" });
  expect(parse("ipwhois", { country_code: "JP", timezone: { id: "Asia/Tokyo" }, connection: { isp: "SoftBank" } })).toMatchObject({ country: "JP", timezone: "Asia/Tokyo", isp: "SoftBank" });
});
