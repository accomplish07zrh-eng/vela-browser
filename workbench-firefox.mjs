/** Runs inside the existing Firefox owner. It never creates or closes a browser context. */
export class FirefoxWorkbench {
  constructor(context) { this.context = context; this.ids = new WeakMap(); this.nextId = 0; this.selected = undefined; }
  pages() {
    return this.context.pages().map((page) => {
      if (!this.ids.has(page)) this.ids.set(page, `viewport-${++this.nextId}`);
      return { page, id: this.ids.get(page) };
    });
  }
  async run(payload) {
    const pages = this.pages();
    if (payload.action === "tabs") return Promise.all(pages.map(async ({ page, id }) => ({ id, title: await page.title().catch(() => "New tab"), url: page.url() })));
    if (payload.action === "new") {
      const page = await this.context.newPage();
      return this.pages().find((entry) => entry.page === page).id;
    }
    const target = pages.find((entry) => entry.id === payload.targetId);
    if (!target) throw new Error("Tab no longer exists");
    const page = target.page;
    if (payload.action === "select") { this.selected = target.id; return null; }
    if (payload.action === "close") {
      if (pages.length === 1) await this.context.newPage();
      await page.close(); return null;
    }
    if (payload.action === "viewport") return page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (payload.action === "frame") {
      const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const bytes = await page.screenshot({ type: "jpeg", quality: payload.focused ? 85 : 65, scale: "css", timeout: 2000 });
      return { data: bytes.toString("base64"), ...size };
    }
    if (payload.action !== "input") throw new Error("Invalid workbench operation");
    const input = payload.input;
    if (input.kind === "text") return page.keyboard.insertText(input.text);
    if (input.kind === "key") {
      const key = input.key === " " ? "Space" : input.key;
      return input.event === "down" ? page.keyboard.down(key) : page.keyboard.up(key);
    }
    await page.mouse.move(input.x, input.y);
    if (input.kind === "wheel") return page.mouse.wheel(input.dx, input.dy);
    if (input.event === "down") return page.mouse.down({ button: input.button, clickCount: input.clicks || 1 });
    if (input.event === "up") return page.mouse.up({ button: input.button, clickCount: input.clicks || 1 });
    return null;
  }
}
