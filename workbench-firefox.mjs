/** Runs inside the existing Firefox or WebKit owner. It never creates or closes a browser context. */

/**
 * Live frames through the screencast Playwright itself uses for videos and traces. It runs in the
 * browser's own compositor, so the page sees nothing: no script, no screenshot, no focus change.
 * playwright-core 1.58 (Firefox) starts it per page and emits frames; playwright-webkit-core 1.65
 * registers clients whose returned promise holds the next frame back.
 * Returns a function that stops it.
 */
export async function startScreencast(page, { width, height, quality, minInterval = 0 }, onFrame) {
  const impl = page?._connection?.toImpl?.(page);
  const screencast = impl?.screencast;
  if (!screencast) throw new Error("Live frames are unavailable for this page");
  let stopped = false;
  if (typeof screencast.addClient === "function") {
    let last = 0;
    const client = {
      size: { width, height }, quality, fps: minInterval ? Math.max(1, Math.min(30, Math.round(1000 / minInterval))) : 25,
      onFrame(frame) {
        if (stopped) return undefined;
        onFrame(frame.buffer);
        const wait = Math.max(0, minInterval - (Date.now() - last)); last = Date.now();
        return new Promise((resolve) => setTimeout(resolve, wait));
      },
      dispose() {},
    };
    screencast.addClient(client);
    return () => { stopped = true; screencast.removeClient(client); };
  }
  if (typeof screencast._startScreencast !== "function") throw new Error("Live frames are unavailable for this page");
  const token = {};
  const listener = (frame) => { if (!stopped) onFrame(frame.buffer); };
  impl.on("screencastframe", listener);
  try { await screencast._startScreencast(token, { width, height, quality }); }
  catch (error) { impl.off("screencastframe", listener); throw error; }
  return () => {
    stopped = true;
    impl.off("screencastframe", listener);
    void Promise.resolve(screencast._stopScreencast(token)).catch(() => {});
  };
}

/**
 * The latest live frame of the selected tab. A request names the last frame it has; it is answered
 * at once when a newer one exists, or as soon as the page paints one, or after `wait` with nothing.
 * A stream nobody asks for stops by itself.
 */
export class LiveFrames {
  constructor(start = startScreencast) {
    this.start = start; this.page = null; this.key = ""; this.stopStream = null; this.seq = 0;
    this.latest = null; this.waiters = new Set(); this.viewport = null; this.measured = 0; this.idle = null;
  }
  /**
   * @param {any} page
   * @param {{ maxWidth?: number, quality?: number, since?: number, wait?: number, minInterval?: number }} [options]
   */
  async next(page, options = {}) {
    const { maxWidth, quality = 70, since = 0, wait = 1500, minInterval = 0 } = options;
    if (!this.viewport || this.page !== page || Date.now() - this.measured > 2000) {
      this.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      this.measured = Date.now();
    }
    const view = this.viewport;
    const width = Math.max(2, Math.min(view.width, Math.round(maxWidth || view.width))) & ~1;
    const height = Math.max(2, Math.round(view.height * width / Math.max(1, view.width))) & ~1;
    const key = `${width}x${height}:${quality}:${minInterval}`;
    if (this.page !== page || this.key !== key || !this.stopStream) {
      this.stop();
      this.page = page; this.key = key;
      this.stopStream = await this.start(page, { width, height, quality, minInterval }, (buffer) => this.push(buffer));
    }
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), Math.max(4000, wait * 3));
    if (this.latest && this.latest.seq > since) return this.withPointer(this.latest);
    if (this.pointers?.length) return this.withPointer({ unchanged: true, seq: this.seq, ...this.viewport });
    return await new Promise((resolve) => {
      const waiter = { resolve };
      this.waiters.add(waiter);
      setTimeout(() => {
        if (!this.waiters.delete(waiter)) return;
        resolve({ unchanged: true, seq: this.seq, ...this.viewport });
      }, wait);
    });
  }
  push(buffer) {
    this.seq++;
    this.latest = { data: buffer.toString("base64"), seq: this.seq, ...this.viewport };
    for (const waiter of this.waiters) waiter.resolve(this.withPointer(this.latest));
    this.waiters.clear();
  }
  /**
   * The AI's human-like pointer, for Vela Browser to draw over its own view of this page. It rides
   * along with the next answer, and wakes a waiting request so it arrives without waiting for paint.
   */
  pointer(event) {
    if (!this.stopStream || (event.page && this.page && event.page !== this.page)) return;
    (this.pointers ??= []).push({ x: Math.round(event.x * 10) / 10, y: Math.round(event.y * 10) / 10, phase: event.phase });
    if (this.pointers.length > 64) this.pointers.splice(0, this.pointers.length - 64);
    if (!this.waiters.size) return;
    const answer = this.withPointer({ unchanged: true, seq: this.seq, ...this.viewport });
    for (const waiter of this.waiters) waiter.resolve(answer);
    this.waiters.clear();
  }
  withPointer(answer) {
    if (!this.pointers?.length) return answer;
    const pointer = this.pointers; this.pointers = [];
    return { ...answer, pointer };
  }
  stop() {
    clearTimeout(this.idle); this.idle = null;
    const stop = this.stopStream; this.stopStream = null; this.page = null; this.key = ""; this.latest = null;
    try { stop?.(); } catch {}
    for (const waiter of this.waiters) waiter.resolve({ unchanged: true, seq: this.seq, ...(this.viewport ?? { width: 0, height: 0 }) });
    this.waiters.clear();
  }
}

export class FirefoxWorkbench {
  constructor(context) { this.context = context; this.ids = new WeakMap(); this.nextId = 0; this.selected = undefined; this.live = new LiveFrames(); }
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
    if (payload.action === "stop-stream") { this.live.stop(); return null; }
    const target = pages.find((entry) => entry.id === payload.targetId);
    if (!target) throw new Error("Tab no longer exists");
    const page = target.page;
    if (payload.action === "select") { if (this.selected !== target.id) this.live.stop(); this.selected = target.id; return null; }
    if (payload.action === "close") {
      if (this.live.page === page) this.live.stop();
      if (pages.length === 1) await this.context.newPage();
      await page.close(); return null;
    }
    if (payload.action === "viewport") return page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (payload.action === "frame") {
      if (payload.stream === true) {
        const number = (value, low, high, fallback) => typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
        return this.live.next(page, {
          maxWidth: number(payload.maxWidth, 160, 2560, undefined), quality: number(payload.quality, 30, 95, 70),
          since: number(payload.since, 0, Number.MAX_SAFE_INTEGER, 0), wait: number(payload.wait, 0, 2500, 1500),
          minInterval: number(payload.minInterval, 0, 2000, 0),
        });
      }
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
