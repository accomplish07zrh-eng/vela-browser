import { expect, test } from "bun:test";
import { MobileView } from "./mobile-view.ts";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
function view() {
  let shots = 0;
  const mobile = new MobileView({
    profiles: () => [{ id: "p1", name: "Shop", group: "A", running: true }, { id: "p2", name: "Idle", group: "", running: false }],
    snapshot: async () => { shots++; return { frame: { data: jpeg }, title: "Orders", url: "https://shop.example/orders?token=secret" }; },
    activity: () => ({ script: { name: "Check in", done: 1, total: 4, failed: 0 }, task: null }),
  });
  (mobile as any).pin = "123456";
  return { mobile, shots: () => shots };
}
const request = (path: string, init: RequestInit = {}) => new Request(`http://192.168.0.2:50480${path}`, init);
const login = (mobile: MobileView, pin: string, ip = "192.168.0.9") => mobile.handle(request("/login", { method: "POST", body: JSON.stringify({ pin }), headers: { "content-type": "application/json" } }), ip);

test("without the PIN there is only the PIN page; nothing about the browsers", async () => {
  const { mobile } = view();
  expect(await (await mobile.handle(request("/"), "x")).text()).toContain('id="pin"');
  expect((await mobile.handle(request("/state"), "x")).status).toBe(401);
  expect((await mobile.handle(request("/frame/p1"), "x")).status).toBe(401);
  expect((await login(mobile, "000000")).status).toBe(401);
});

test("with the PIN: running browsers, their pictures and progress, and only the host of the page", async () => {
  const { mobile, shots } = view();
  const response = await login(mobile, "123456");
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  const frame = await mobile.handle(request("/frame/p1", { headers: { cookie } }), "x");
  expect(frame.headers.get("content-type")).toBe("image/jpeg");
  await mobile.handle(request("/frame/p1", { headers: { cookie } }), "x");
  expect(shots()).toBe(1);
  expect((await mobile.handle(request("/frame/p2", { headers: { cookie } }), "x")).status).toBe(404);
  const state = await (await mobile.handle(request("/state", { headers: { cookie } }), "x")).json() as any;
  expect(state.profiles).toEqual([{ id: "p1", name: "Shop", group: "A", engine: "chromium", title: "Orders", host: "shop.example" }]);
  expect(JSON.stringify(state)).not.toContain("secret");
  expect(state.script).toEqual({ name: "Check in", done: 1, total: 4, failed: 0 });
  // Read only: nothing but GET, apart from signing in.
  expect((await mobile.handle(request("/state", { method: "POST", headers: { cookie } }), "x")).status).toBe(405);
});

test("guessing is slowed to five tries a minute and stopped after twenty", async () => {
  const { mobile } = view();
  for (let i = 0; i < 5; i++) expect((await login(mobile, "999999")).status).toBe(401);
  expect((await login(mobile, "123456")).status).toBe(429);
  // Another address is counted on its own.
  expect((await login(mobile, "123456", "192.168.0.10")).status).toBe(200);
});
