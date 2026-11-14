import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore, legacyHubUrl, parseAppConfig } from "./app-config.ts";

describe("Vela Browser app config", () => {
  test("fresh installs open the local workspace with analytics disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-config-"));
    expect(new AppConfigStore(join(root, "config.json")).read()).toEqual({
      version: 1,
      mode: "local",
      localAnalytics: false,
    });
  });

  test("all supported legacy configurations retire their account endpoint", () => {
    for (const mode of ["unconfigured", "local", "cloud"]) {
      for (const cloudUrl of [undefined, "https://old.example.test", "not a URL"]) {
        expect(parseAppConfig({ version: 1, mode, cloudUrl, localAnalytics: true, servicesHidden: true })).toEqual({
          version: 1, mode: "local", localAnalytics: true, servicesHidden: true,
        });
      }
    }
  });

  test("normalizes a legacy configuration atomically and preserves preferences", () => {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-config-"));
    const path = join(root, "config.json");
    const store = new AppConfigStore(path);
    try {
      writeFileSync(path, JSON.stringify({ version: 1, mode: "cloud", cloudUrl: "https://old.example.test", localAnalytics: true, servicesHidden: true }));
      expect(store.write(store.read())).toEqual({ version: 1, mode: "local", localAnalytics: true, servicesHidden: true });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(store.read());
      expect(readFileSync(path, "utf8")).not.toContain("cloudUrl");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the retired mode cannot be enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-config-"));
    const store = new AppConfigStore(join(root, "config.json"));
    expect(() => store.setMode("cloud", "https://old.example.test")).toThrow("removed");
    expect(store.setMode("local")).toEqual({ version: 1, mode: "local", localAnalytics: false });
  });

  test("legacy HUB_URL cannot restore account or remote startup", () => {
    const env = { HUB_URL: "https://legacy-hub.example" };
    expect(legacyHubUrl({ version: 1, mode: "unconfigured", localAnalytics: false }, env))
      .toBeUndefined();
    expect(legacyHubUrl({ version: 1, mode: "local", localAnalytics: false }, env)).toBeUndefined();
    expect(legacyHubUrl({
      version: 1,
      mode: "cloud",
      cloudUrl: "https://cloud.aliasmode.test",
      localAnalytics: false,
    }, env)).toBeUndefined();
  });

  test("kernelDns preserves valid presets and ignores unknown values", () => {
    for (const kernelDns of ["auto", "cn", "global"] as const) {
      expect(parseAppConfig({ version: 1, mode: "local", localAnalytics: false, kernelDns })).toEqual({
        version: 1,
        mode: "local",
        localAnalytics: false,
        kernelDns,
      });
    }
    expect(parseAppConfig({ version: 1, mode: "local", localAnalytics: false, kernelDns: "bogus" })).toEqual({
      version: 1,
      mode: "local",
      localAnalytics: false,
    });
  });

  test("unsupported configuration data is rejected without overwriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "vela-config-invalid-"));
    const path = join(root, "config.json");
    const store = new AppConfigStore(path);
    try {
      for (const value of [{ version: 2, mode: "local" }, { version: 1, mode: "unknown" }]) {
        const raw = JSON.stringify(value);
        writeFileSync(path, raw);
        expect(() => store.write(store.read())).toThrow();
        expect(readFileSync(path, "utf8")).toBe(raw);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
