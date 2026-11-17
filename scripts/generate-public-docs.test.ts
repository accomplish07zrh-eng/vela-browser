import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Launcher } from "../src/launcher.ts";
import { ProfileStore } from "../src/store.ts";
import { handleRequest } from "../src/server.ts";
import { handleUserApi } from "../src/adspower-users.ts";
import { DEVTOOLS_TOOLS } from "../agent/devtools.mjs";
import {
  CURRENT_CATALOG_PATH,
  MANIFEST_PATH,
  OPENAPI_PATH,
  PUBLIC_DOCS_DIR,
  generateCurrentSourceCatalog,
  serialize,
  sha256,
} from "./generate-public-docs.mjs";

const RELEASED_CATALOG_PATH = "mcp-tools/0.1.0-beta.42.json";
const BETA42_ALIASMODE_TOOLS = [
  "aliasmode_profiles_list",
  "aliasmode_profile_create",
  "aliasmode_profile_delete",
  "aliasmode_browser_open",
  "aliasmode_browser_select",
  "aliasmode_browser_status",
  "aliasmode_browser_close",
  "browser_close",
];
const DOCUMENTED_ROUTES = [
  "get /status",
  "get /api/v1/status",
  "get /api/v1/browser/start",
  "get /api/v1/browser/stop",
  "get /api/v1/browser/active",
  "post /api/v2/browser-profile/create",
  "post /api/v2/browser-profile/update",
  "post /api/v2/browser-profile/list",
  "post /api/v2/browser-profile/start",
  "get /api/v2/browser-profile/active",
  "post /api/v2/browser-profile/stop",
  "post /api/v2/browser-profile/delete",
  "post /api/v2/browser-profile/delete-cache",
  "get /api/v1/browser/cookies",
  "get /api/v1/group/list",
  "post /api/v1/group/create",
  "get /api/v1/user/list",
  "post /api/v1/user/create",
  "post /api/v1/user/delete",
  "post /api/v1/user/update",
];

const read = (path: string) => readFileSync(join(PUBLIC_DOCS_DIR, path), "utf8");
const openapi = JSON.parse(read(OPENAPI_PATH));
const manifest = JSON.parse(read(MANIFEST_PATH));

function operations(): Array<{ method: string; path: string; op: any }> {
  const out: Array<{ method: string; path: string; op: any }> = [];
  for (const [path, methods] of Object.entries<any>(openapi.paths)) {
    for (const [method, op] of Object.entries<any>(methods)) out.push({ method, path, op });
  }
  return out;
}

function schema(ref: string): any {
  return openapi.components.schemas[ref.replace("#/components/schemas/", "")];
}

/** Property names of the success `data` schema documented for one operation. */
function documentedDataKeys(op: any): string[] {
  let response = op.responses["200"].content["application/json"].schema;
  if (response.oneOf) response = response.oneOf[0];
  const data = schema(response.$ref).allOf.find((part: any) => part.properties?.data).properties.data;
  const keys = (part: any) => Object.keys((part.$ref ? schema(part.$ref) : part).properties ?? {});
  return data.oneOf ? data.oneOf.flatMap(keys) : keys(data);
}

test("OpenAPI document is 3.1 and lists the public loopback routes", () => {
  expect(openapi.openapi.startsWith("3.1")).toBe(true);
  expect(openapi.servers[0].url).toBe("http://127.0.0.1:50400");
  const ops = operations();
  expect(ops.map((o) => `${o.method} ${o.path}`).sort()).toEqual([...DOCUMENTED_ROUTES].sort());
  expect(new Set(ops.map((o) => o.op.operationId)).size).toBe(DOCUMENTED_ROUTES.length);
  for (const { path, op } of ops) {
    expect(path).not.toMatch(/\/ui\/api|\/api\/agent\/|\/api\/xactions\//);
    const introduced = ["profileCreateV2", "profileUpdateV2", "profileDeleteV2"].includes(op.operationId) ? "0.1.19"
      : op.operationId.endsWith("V2") ? "0.1.18" : "0.1.0-beta.42";
    expect(op["x-aliasmode-version-introduced"]).toBe(introduced);
  }
});

const BASE = "http://127.0.0.1:50400";
const get = (path: string) => new Request(`${BASE}${path}`);
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function fakes() {
  const store = new ProfileStore(":memory:");
  const launcher = {
    start: async () => ({ ws: "ws://127.0.0.1:9222/devtools/browser/test", port: 9222 }),
    stop: async () => true,
    cacheCleanupSettled: async () => {},
    captureLocalSession: async () => false,
    certifiedActive: async () => true,
    clearCache: async () => {},
    removeUserDataDir: () => true,
    userDataDir: (id: string) => `/tmp/aliasmode-public-docs-test/${id}`,
  } as unknown as Launcher;
  return { store, launcher };
}

test("every documented operation is recognised by the real handlers with the documented data shape", async () => {
  const { store, launcher } = fakes();
  const byId = new Map(operations().map(({ op }) => [op.operationId, op]));
  const call = async (operationId: string, req: Request) => {
    const users = await handleUserApi(req, launcher, store);
    const handler = users ? "handleUserApi" : "handleRequest";
    const body = await (users ?? await handleRequest(req, launcher, store)).json();
    expect(body.msg, operationId).not.toMatch(/^unknown route/);
    const op = byId.get(operationId);
    expect(op, operationId).toBeDefined();
    expect(handler).toBe(op.tags[0] === "browser" || op.tags[0] === "status" ? "handleRequest" : "handleUserApi");
    if (body.code === 0) {
      for (const key of Object.keys(body.data)) expect(documentedDataKeys(op), `${operationId}.data.${key}`).toContain(key);
    }
    return body;
  };

  const created = await call("userCreate", post("/api/v1/user/create", { name: "research-01", group_id: "research", domain_name: "x.com" }));
  expect(created.code).toBe(0);
  const id = created.data.id as string;
  const launchArgs = encodeURIComponent(JSON.stringify(["--window-size=1280,720"]));
  const sort = encodeURIComponent(JSON.stringify({ created_time: "asc" }));

  expect((await call("localApiStatus", get("/status"))).code).toBe(0);
  expect((await call("localApiStatusV1", get("/api/v1/status"))).code).toBe(0);
  expect((await call("browserStart", get(`/api/v1/browser/start?user_id=${id}&launch_args=${launchArgs}`))).data.debug_port).toBe("9222");
  expect((await call("browserActive", get(`/api/v1/browser/active?user_id=${id}`))).data.status).toBe("Inactive");
  expect((await call("browserStop", get(`/api/v1/browser/stop?user_id=${id}`))).code).toBe(0);
  const profileNo = String(store.getSerial(id));
  expect((await call("profileListV2", post("/api/v2/browser-profile/list", { profile_no: [profileNo] }))).data.list[0])
    .toMatchObject({ profile_id: id, profile_no: profileNo });
  expect((await call("browserStartV2", post("/api/v2/browser-profile/start", { profile_no: profileNo, headless: "1" }))).data.debug_port).toBe("9222");
  expect((await call("browserActiveV2", get(`/api/v2/browser-profile/active?profile_no=${profileNo}`))).data.status).toBe("Inactive");
  expect((await call("browserStopV2", post("/api/v2/browser-profile/stop", { profile_id: id }))).code).toBe(0);
  expect((await call("browserProfileDeleteCache", post("/api/v2/browser-profile/delete-cache", { profile_id: [id], type: ["image_file"] }))).code).toBe(0);
  expect((await call("browserCookies", get(`/api/v1/browser/cookies?user_id=${id}`))).msg).toBe(`profile not running: ${id}`);
  expect((await call("groupList", get("/api/v1/group/list?page=1&page_size=100"))).data.list).toEqual([{ group_id: "research", group_name: "research" }]);
  expect((await call("groupCreate", post("/api/v1/group/create", { group_name: "outreach" }))).data.group_id).toBe("outreach");
  expect((await call("userList", get(`/api/v1/user/list?page=1&page_size=100&user_sort=${sort}`))).data.list[0].user_id).toBe(id);
  expect((await call("userUpdate", post("/api/v1/user/update", { user_id: id, name: "research-01-renamed", username: "example_user" }))).code).toBe(0);
  expect((await call("userDelete", post("/api/v1/user/delete", { user_ids: [id] }))).data).toEqual({ deleted: 1, locked: [] });
  const migrated = await call("profileCreateV2", post("/api/v2/browser-profile/create", { name: "V2 migration", group_id: "research" }));
  expect(migrated.code).toBe(0);
  expect((await call("profileUpdateV2", post("/api/v2/browser-profile/update", {
    profile_id: migrated.data.profile_id, remark: "Updated",
  }))).code).toBe(0);
  expect((await call("profileDeleteV2", post("/api/v2/browser-profile/delete", {
    profile_id: [migrated.data.profile_id, migrated.data.profile_id],
  }))).data).toEqual({ deleted: 1, locked: [] });
});

test("undocumented paths are rejected by both handlers", async () => {
  const { store, launcher } = fakes();
  const req = get("/api/v1/browser/does-not-exist");
  expect(await handleUserApi(req, launcher, store)).toBeNull();
  expect((await (await handleRequest(req, launcher, store)).json()).msg).toBe("unknown route: /api/v1/browser/does-not-exist");
});

test("current-source MCP catalog is deterministic and committed", async () => {
  const first = await generateCurrentSourceCatalog();
  const second = await generateCurrentSourceCatalog();
  expect(serialize(first)).toBe(serialize(second));
  expect(read(CURRENT_CATALOG_PATH).replace(/\r\n/g, "\n")).toBe(serialize(first));
});

test("MCP catalogs list the expected tools", () => {
  const current = JSON.parse(read(CURRENT_CATALOG_PATH));
  const released = JSON.parse(read(RELEASED_CATALOG_PATH));
  expect(released.status).toBe("released");
  expect(released.sourceRef).toBe("v0.1.0-beta.42");
  expect(released.playwrightToolAvailability).toBe("after-browser-selection");
  expect(released.aliasModeTools.map((tool: any) => tool.name)).toEqual(BETA42_ALIASMODE_TOOLS);
  expect(current.status).toBe("source");
  expect(current.playwrightToolAvailability).toBe("listed-before-selection");
  const proxyPoolTools = ["vela_proxy_pool_list", "vela_proxy_pool_check", "vela_ip_score", "vela_browser_set_proxy"];
  const automationTools = [
    "vela_guide", "vela_profile_update", "vela_scripts_list", "vela_script_read",
    "vela_script_save", "vela_script_run", "vela_script_run_status", "vela_script_stop",
    "vela_plugins_list", "vela_plugin_save", "vela_browser_task", "vela_browser_replay",
    "vela_browser_kernel", "vela_browser_network", "vela_worker", "vela_profile_portable", "vela_android",
  ];
  expect(current.aliasModeTools.length).toBe(10 + proxyPoolTools.length + automationTools.length + DEVTOOLS_TOOLS.length);
  for (const tool of DEVTOOLS_TOOLS) expect(current.aliasModeTools.some((item: any) => item.name === tool.name)).toBe(true);
  for (const name of [...proxyPoolTools, ...automationTools]) expect(current.aliasModeTools.some((item: any) => item.name === name)).toBe(true);
  expect(current.aliasModeTools.map((tool: any) => tool.name)).not.toContain("aliasmode_profiles_replace_proxies");
  expect(current.aliasModeTools.map((tool: any) => tool.name)).not.toContain("aliasmode_profile_update");
  for (const catalog of [current, released]) {
    const names = [...catalog.aliasModeTools, ...catalog.playwrightTools].map((tool: any) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(catalog.playwrightTools.length).toBeGreaterThan(0);
    expect(names).not.toContain("browser_install");
    expect(catalog.playwrightTools.map((tool: any) => tool.name)).not.toContain("browser_close");
    expect(catalog.filteredPlaywrightTools).toEqual(["browser_close", "browser_install"]);
  }
});

test("manifest sha256 values match the committed files", () => {
  expect(manifest.productVersion).toBe(openapi.info.version);
  expect(manifest.releasedVersions).toContain("0.1.0-beta.42");
  expect(sha256(read(manifest.openapi.path))).toBe(manifest.openapi.sha256);
  expect(Object.keys(manifest.mcpCatalogs)).toEqual(["current-source", ...manifest.releasedVersions]);
  for (const entry of Object.values<any>(manifest.mcpCatalogs)) {
    expect(sha256(read(entry.path))).toBe(entry.sha256);
  }
});
