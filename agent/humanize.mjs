// Human-like input for AI-driven browsers.
//
// The official Playwright MCP clicks the exact centre of an element with a teleported pointer and
// fills text in one write. This layer performs the same tool calls the way a person would: the
// pointer travels on a curved, accelerating path, lands somewhere inside the target, presses and
// releases with a short hold, scrolls with the wheel, and types key by key at an uneven rhythm.
// Every profile has its own stable habits (speed, curvature, typing rhythm), so one environment
// behaves consistently across sessions while two environments do not move alike.
//
// Anything this layer cannot do faithfully (an ambiguous element reference, a covered or disabled
// target, an unknown tool) is handed to the official tool unchanged, so results never get worse.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value) => Math.round(value * 100) / 100;

function hash32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small seeded generator; the persona must be identical every time a profile is used. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Stable input habits for one profile. */
export function personaFor(profileId) {
  const random = seededRandom(hash32(`vela-persona:${profileId}`));
  return {
    speed: round(0.8 + random() * 0.5),
    curvature: round(0.06 + random() * 0.2),
    overshoot: round(0.12 + random() * 0.3),
    tremor: round(0.15 + random() * 0.45),
    cpm: Math.round(190 + random() * 210),
    rhythm: round(0.22 + random() * 0.22),
    typo: random() < 0.35 ? 0 : round(0.004 + random() * 0.01),
    dwell: Math.round(70 + random() * 110),
    hold: Math.round(55 + random() * 50),
    hue: Math.floor(random() * 360),
  };
}

/** Minimum-jerk position profile: slow start, fast middle, gentle landing. */
const minimumJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function segment(from, to, duration, persona, random, curl) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const nx = distance ? -dy / distance : 0, ny = distance ? dx / distance : 0;
  const bend = distance * persona.curvature * curl;
  const p1 = { x: from.x + dx * 0.3 + nx * bend * (0.6 + random() * 0.8), y: from.y + dy * 0.3 + ny * bend * (0.6 + random() * 0.8) };
  const p2 = { x: from.x + dx * 0.72 + nx * bend * (0.2 + random() * 0.6), y: from.y + dy * 0.72 + ny * bend * (0.2 + random() * 0.6) };
  const steps = Math.max(4, Math.round(duration / 14));
  const points = [];
  for (let index = 1; index <= steps; index++) {
    const progress = index / steps;
    const point = bezier(from, p1, p2, to, minimumJerk(progress));
    const shake = index === steps ? 0 : persona.tremor * (1 - progress * 0.6);
    points.push({ x: point.x + gaussian(random) * shake, y: point.y + gaussian(random) * shake, t: duration * progress });
  }
  points[points.length - 1] = { x: to.x, y: to.y, t: duration };
  return points;
}

/**
 * Pointer path from one point to another, timed by Fitts' law and the persona's speed.
 * Long moves sometimes overshoot and correct, as hands do. Times are milliseconds from the start.
 */
export function planPath(from, to, { width = 40, persona, random = Math.random, speed = 1 }) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 1.5) return [{ x: to.x, y: to.y, t: 0 }];
  const pace = persona.speed * speed;
  const duration = clamp((110 + 140 * Math.log2(distance / Math.max(width, 6) + 1)) / pace * (0.85 + random() * 0.3), 80, 1600);
  const curl = random() < 0.5 ? -1 : 1;
  if (distance > 220 && random() < persona.overshoot) {
    const dirX = (to.x - from.x) / distance, dirY = (to.y - from.y) / distance;
    const beyond = distance * (0.025 + random() * 0.045);
    const aim = { x: to.x + dirX * beyond + gaussian(random) * 3, y: to.y + dirY * beyond + gaussian(random) * 3 };
    const first = segment(from, aim, duration * 0.88, persona, random, curl);
    const pause = 30 + random() * 60;
    const correction = segment(aim, to, (90 + random() * 110) / pace, { ...persona, curvature: persona.curvature * 0.3 }, random, -curl);
    const offset = first[first.length - 1].t + pause;
    return [...first, ...correction.map((point) => ({ ...point, t: point.t + offset }))];
  }
  return segment(from, to, duration, persona, random, curl);
}

/** A landing point inside a box: near the centre, never on the edge, never the exact centre twice. */
export function targetPoint(box, random = Math.random) {
  const marginX = Math.min(box.width * 0.18, 12), marginY = Math.min(box.height * 0.18, 8);
  const x = box.x + clamp(box.width / 2 + gaussian(random) * box.width * 0.16, marginX, box.width - marginX);
  const y = box.y + clamp(box.height / 2 + gaussian(random) * box.height * 0.14, marginY, box.height - marginY);
  return { x: round(x), y: round(y) };
}

const PAUSE_AFTER = new Set([".", ",", "!", "?", ";", ":", "，", "。", "！", "？", "；", "："]);

/** Delay before each character, in milliseconds. */
export function typingDelays(text, { persona, random = Math.random, speed = 1 }) {
  const base = 60_000 / (persona.cpm * speed);
  const chars = [...text];
  let sinceThought = 0;
  return chars.map((char, index) => {
    const previous = chars[index - 1];
    let delay = base * Math.exp(gaussian(random) * persona.rhythm);
    if (previous === " ") delay *= 1.12;
    if (/[A-Z]/.test(char)) delay += 35 + random() * 40;
    if (previous && PAUSE_AFTER.has(previous)) delay += 140 + random() * 260;
    sinceThought++;
    if (sinceThought > 18 && random() < 0.035) { delay += 350 + random() * 750; sinceThought = 0; }
    return Math.round(clamp(delay, 25, 2500));
  });
}

const NEIGHBOURS = {
  a: "qwsz", b: "vghn", c: "xdfv", d: "serfcx", e: "wsdr", f: "drtgvc", g: "ftyhbv", h: "gyujnb", i: "ujko",
  j: "huikmn", k: "jiolm", l: "kop", m: "njk", n: "bhjm", o: "iklp", p: "ol", q: "wa", r: "edft", s: "awedxz",
  t: "rfgy", u: "yhji", v: "cfgb", w: "qase", x: "zsdc", y: "tghu", z: "asx",
};

function neighbour(char, random) {
  const lower = char.toLowerCase();
  const options = NEIGHBOURS[lower];
  if (!options) return undefined;
  const pick = options[Math.floor(random() * options.length)];
  return char === lower ? pick : pick.toUpperCase();
}

const HUMANIZED_TOOLS = new Set([
  "browser_click", "browser_hover", "browser_type", "browser_fill_form", "browser_select_option",
  "browser_drag", "browser_press_key", "browser_mouse_move_xy", "browser_mouse_click_xy", "browser_mouse_drag_xy",
]);

function withNote(result, note) {
  if (!result || !Array.isArray(result.content)) return result;
  return { ...result, content: [{ type: "text", text: note }, ...result.content] };
}

/**
 * @param {object} options
 * @param {import("playwright-core").BrowserContext} options.context
 * @param {string} options.profileId
 * @param {(name: string, args: object) => Promise<any>} options.callOfficial
 */
export function createHumanizer({ context, profileId, callOfficial, platform = process.platform }) {
  const persona = personaFor(profileId);
  const random = Math.random;
  const positions = new WeakMap();
  const settings = { enabled: true, speed: 1 };
  const commandKey = platform === "darwin" ? "Meta" : "Control";

  const viewportOf = async (page) => page.viewportSize?.() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));

  const positionOf = async (page) => {
    const known = positions.get(page);
    if (known) return known;
    const viewport = await viewportOf(page).catch(() => ({ width: 1280, height: 800 }));
    // A person's pointer is already resting somewhere on the page, rarely in a corner.
    const start = { x: round(viewport.width * (0.35 + random() * 0.3)), y: round(viewport.height * (0.45 + random() * 0.3)) };
    positions.set(page, start);
    return start;
  };

  const moveTo = async (page, point, width = 40, pace = 1) => {
    const from = await positionOf(page);
    const path = planPath(from, point, { width, persona, random, speed: settings.speed * pace });
    const started = performance.now();
    for (const step of path) {
      await sleep(started + step.t - performance.now());
      await page.mouse.move(step.x, step.y);
    }
    positions.set(page, point);
  };

  const press = async (page, point, { button = "left", clickCount = 1, modifiers = [] } = {}) => {
    const keys = modifiers.map((key) => key === "ControlOrMeta" ? commandKey : key);
    for (const key of keys) await page.keyboard.down(key);
    await sleep(persona.dwell * (0.6 + random() * 0.8) / settings.speed);
    for (let click = 1; click <= clickCount; click++) {
      await page.mouse.down({ button, clickCount: click });
      await sleep(persona.hold * (0.7 + random() * 0.6));
      await page.mouse.up({ button, clickCount: click });
      if (click < clickCount) await sleep(70 + random() * 70);
    }
    for (const key of keys.reverse()) await page.keyboard.up(key);
  };

  /** The one page whose latest snapshot knows this reference; ambiguity falls back to the official tool. */
  const locate = async (ref) => {
    if (typeof ref !== "string" || !ref) return undefined;
    const hits = [];
    for (const page of context.pages()) {
      if (page.isClosed?.()) continue;
      const locator = page.locator(`aria-ref=${ref}`);
      try { if (await locator.count() === 1) hits.push({ page, locator }); } catch {}
    }
    return hits.length === 1 ? hits[0] : undefined;
  };

  const scrollIntoReach = async (page, locator) => {
    const viewport = await viewportOf(page);
    let previous;
    for (let attempt = 0; attempt < 40; attempt++) {
      const box = await locator.boundingBox();
      if (!box) return;
      const visibleHeight = Math.min(box.height, viewport.height * 0.6);
      if (box.y >= 24 && box.y + visibleHeight <= viewport.height - 24) return;
      if (previous !== undefined && Math.abs(previous - box.y) < 1) break; // the wheel moves another scroller
      previous = box.y;
      const goal = viewport.height * (0.3 + random() * 0.3);
      const distance = box.y + box.height / 2 - goal;
      const step = Math.sign(distance) * Math.min(Math.abs(distance), 80 + random() * 110);
      await page.mouse.wheel(0, Math.round(step));
      await sleep(30 + random() * 70 + (random() < 0.12 ? 150 + random() * 250 : 0));
    }
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  };

  /** Scroll, settle, then move onto a point of the element that really receives the click. */
  const approach = async (page, locator, pace = 1) => {
    if (!(await locator.isVisible().catch(() => false))) return undefined;
    await scrollIntoReach(page, locator);
    let box = await locator.boundingBox();
    for (let attempt = 0; box && attempt < 5; attempt++) {
      await sleep(40);
      const next = await locator.boundingBox();
      if (next && Math.abs(next.x - box.x) < 0.5 && Math.abs(next.y - box.y) < 0.5) break;
      box = next;
    }
    if (!box || box.width < 1 || box.height < 1) return undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const point = targetPoint(box, random);
      const receives = await locator.evaluate((element, { x, y }) => {
        if (window !== window.top) return true;
        const hit = document.elementFromPoint(x, y);
        if (!hit) return false;
        if (hit === element || element.contains(hit)) return true;
        return [...(element.labels ?? [])].some((label) => label.contains(hit));
      }, point).catch(() => false);
      if (receives) {
        await moveTo(page, point, Math.min(box.width, box.height), pace);
        return point;
      }
    }
    return undefined;
  };

  const settle = async (page) => {
    await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
    await sleep(180 + random() * 220);
  };

  const typeText = async (page, text, field) => {
    const delays = typingDelays(text, { persona, random, speed: settings.speed });
    const allowTypos = persona.typo > 0 && ["text", "search", "textarea"].includes(field);
    try {
      const chars = [...text];
      for (let index = 0; index < chars.length; index++) {
        await sleep(delays[index]);
        const char = chars[index];
        const wrong = allowTypos && random() < persona.typo ? neighbour(char, random) : undefined;
        if (wrong) {
          await page.keyboard.type(wrong);
          await sleep(140 + random() * 260);
          await page.keyboard.press("Backspace");
          await sleep(60 + random() * 120);
        }
        if (char === "\n") await page.keyboard.press("Enter");
        else await page.keyboard.type(char);
      }
    } finally {
    }
  };

  const fieldKind = (locator) => locator.evaluate((element) => {
    if (element.isContentEditable) return "editable";
    if (element.tagName === "TEXTAREA") return "textarea";
    if (element.tagName === "INPUT") return (element.getAttribute("type") || "text").toLowerCase();
    return "other";
  }).catch(() => "other");

  /** Click into a field, select what is there, and type over it. Returns false to fall back. */
  const typeInto = async (page, locator, text) => {
    if (!(await locator.isEditable().catch(() => false))) return false;
    const point = await approach(page, locator);
    if (!point) return false;
    await press(page, point);
    const focused = await locator.evaluate((element) => element === document.activeElement || element.contains(document.activeElement)).catch(() => false);
    if (!focused) await locator.focus().catch(() => {});
    const field = await fieldKind(locator);
    const existing = await locator.evaluate((element) => "value" in element ? element.value : element.isContentEditable ? element.innerText : "").catch(() => "");
    if (existing) {
      await sleep(120 + random() * 200);
      await page.keyboard.press(`${commandKey}+A`);
      await sleep(80 + random() * 140);
      if (!text) await page.keyboard.press("Backspace");
    }
    if (text) await typeText(page, text, field);
    return true;
  };

  /** The only open page, for coordinate tools that name no element. */
  const onlyPage = () => {
    const pages = context.pages().filter((page) => !page.isClosed?.());
    return pages.length === 1 ? pages[0] : undefined;
  };

  const humanized = async (page, outcome) => {
    await settle(page);
    return withNote(await callOfficial("browser_snapshot", {}), outcome);
  };

  const call = async (name, args = {}) => {
    if (name === "browser_press_key") {
      await sleep((90 + random() * 180) / settings.speed);
      return callOfficial(name, args);
    }
    if (name === "browser_click" || name === "browser_hover") {
      const found = await locate(args.ref);
      const point = found && await approach(found.page, found.locator);
      if (!point) return callOfficial(name, args);
      if (name === "browser_hover") {
        await sleep(120 + random() * 200);
        return humanized(found.page, `Hovered ${args.element ?? "the element"} with human-like pointer movement.`);
      }
      if (!(await found.locator.isEnabled().catch(() => true))) return callOfficial(name, args);
      await press(found.page, point, { button: args.button ?? "left", clickCount: args.doubleClick ? 2 : 1, modifiers: args.modifiers ?? [] });
      return humanized(found.page, `Clicked ${args.element ?? "the element"} with human-like pointer movement.`);
    }
    if (name === "browser_type") {
      const found = await locate(args.ref);
      if (!found || !(await typeInto(found.page, found.locator, String(args.text ?? "")))) return callOfficial(name, args);
      if (args.submit) { await sleep(200 + random() * 350); await found.page.keyboard.press("Enter"); }
      return humanized(found.page, `Typed into ${args.element ?? "the field"} key by key.`);
    }
    if (name === "browser_select_option") {
      const found = await locate(args.ref);
      if (found) await approach(found.page, found.locator);
      if (found) await sleep(150 + random() * 250);
      return callOfficial(name, args);
    }
    if (name === "browser_fill_form" && Array.isArray(args.fields)) {
      let lastPage;
      const results = [];
      for (const field of args.fields) {
        const found = await locate(field.ref);
        lastPage = found?.page ?? lastPage;
        let done = false;
        if (found && field.type === "textbox") done = await typeInto(found.page, found.locator, String(field.value ?? ""));
        if (found && (field.type === "checkbox" || field.type === "radio")) {
          const want = field.value === true || field.value === "true";
          const checked = await found.locator.isChecked().catch(() => undefined);
          if (checked === want) done = true;
          else if (checked !== undefined) {
            const point = await approach(found.page, found.locator);
            if (point) { await press(found.page, point); done = (await found.locator.isChecked().catch(() => !want)) === want; }
          }
        }
        if (!done) {
          if (found) await approach(found.page, found.locator);
          results.push(await callOfficial("browser_fill_form", { fields: [field] }));
        }
        await sleep(220 + random() * 480);
      }
      const failed = results.find((result) => result?.isError);
      if (failed) return failed;
      return lastPage ? humanized(lastPage, "Filled the form field by field with human-like input.") : callOfficial("browser_snapshot", {});
    }
    if (name === "browser_drag") {
      const start = await locate(args.startRef), end = await locate(args.endRef);
      if (!start || !end || start.page !== end.page) return callOfficial(name, args);
      const from = await approach(start.page, start.locator);
      const endBox = from && await end.locator.boundingBox();
      if (!from || !endBox) return callOfficial(name, args);
      await sleep(persona.dwell);
      await start.page.mouse.down();
      await sleep(120 + random() * 160);
      await moveTo(start.page, targetPoint(endBox, random), Math.min(endBox.width, endBox.height), 0.6);
      await sleep(100 + random() * 150);
      await start.page.mouse.up();
      return humanized(start.page, "Dragged with human-like pointer movement.");
    }
    if (name === "browser_mouse_move_xy" || name === "browser_mouse_click_xy" || name === "browser_mouse_drag_xy") {
      const page = onlyPage();
      if (!page) return callOfficial(name, args);
      if (name === "browser_mouse_drag_xy") {
        const from = { x: args.startX, y: args.startY }, to = { x: args.endX, y: args.endY };
        await moveTo(page, from);
        await sleep(persona.dwell);
        await page.mouse.down();
        await sleep(120 + random() * 160);
        await moveTo(page, to, 40, 0.6);
        await page.mouse.up();
        return humanized(page, "Dragged with human-like pointer movement.");
      }
      const point = { x: args.x, y: args.y };
      await moveTo(page, point);
      if (name === "browser_mouse_click_xy") await press(page, point);
      return humanized(page, name === "browser_mouse_click_xy" ? "Clicked with human-like pointer movement." : "Moved the pointer like a person would.");
    }
    return callOfficial(name, args);
  };

  return {
    persona,
    settings,
    configure(next = {}) {
      if (typeof next.enabled === "boolean") settings.enabled = next.enabled;
      if (typeof next.speed === "number" && Number.isFinite(next.speed)) settings.speed = clamp(next.speed, 0.4, 2.5);
      return { ...settings };
    },
    handles(name) { return settings.enabled && HUMANIZED_TOOLS.has(name); },
    async call(name, args) {
      if (!this.handles(name)) return callOfficial(name, args);
      try {
        return await call(name, args);
      } catch (error) {
        // A page that navigated or closed mid-gesture: report like the official tool would.
        if (/Target (page, context or browser )?closed|has been closed|detached/i.test(String(error?.message))) return callOfficial("browser_snapshot", {});
        throw error;
      }
    },
  };
}
