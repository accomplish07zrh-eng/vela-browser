/** A plain CDP connection. Unlike Playwright's connectOverCDP it attaches to no tab by itself. */
export async function openCdp(endpoint, timeout) {
  const deadline = Date.now() + timeout;
  const url = /^https?:/.test(endpoint)
    ? (await (await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(timeout) })).json()).webSocketDebuggerUrl
    : endpoint;
  const socket = new WebSocket(url);
  const within = (promise, what, cleanup = false) => {
    let timer;
    const remaining = cleanup ? 1500 : Math.max(1, deadline - Date.now());
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), remaining); })])
      .finally(() => clearTimeout(timer));
  };
  try {
    await within(new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = socket.onclose = () => reject(new Error("CDP connection failed"));
    }), "CDP connection");
  } catch (error) {
    socket.close();
    throw error;
  }
  let lastId = 0;
  const calls = new Map();
  const listeners = new Set();
  socket.onmessage = ({ data }) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    const call = calls.get(message.id);
    if (!call) return void listeners.forEach((listener) => listener(message));
    calls.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message || "CDP call failed"));
    else call.resolve(message.result ?? {});
  };
  socket.onclose = () => { for (const call of calls.values()) call.reject(new Error("CDP connection closed")); calls.clear(); };
  return {
    send(method, params = {}, sessionId, cleanup = false) {
      const id = ++lastId;
      const reply = new Promise((resolve, reject) => {
        calls.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
      return within(reply, method, cleanup).finally(() => calls.delete(id));
    },
    on(method, sessionId, listener) {
      const filtered = (message) => { if (message.method === method && message.sessionId === sessionId) listener(message.params); };
      listeners.add(filtered);
      return () => listeners.delete(filtered);
    },
    once(method, sessionId) {
      let off;
      return within(new Promise((resolve) => { off = this.on(method, sessionId, resolve); }), method).finally(() => off());
    },
    close() { socket.close(); },
  };
}

const FINGERPRINT_URL = "https://fingerprint.aliasmode.invalid/?__aliasmode_fingerprint__=1";

/**
 * The launch-time fingerprint capture of a Chromium browser, in its own background tab. Playwright's
 * connectOverCDP would attach to every tab (Runtime.enable, Page.enable), and a tab that loads
 * meanwhile, such as one the browser restores at startup, then plays unmuted media and runs audio
 * without a click, as under automation. This connection attaches to the capture tab only.
 */
export async function chromiumFingerprint(endpoint, script, timeout) {
  const cdp = await openCdp(endpoint, timeout);
  let targetId;
  try {
    ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank", background: true }));
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => cdp.send(method, params, sessionId);
    let intercepted = false;
    cdp.on("Fetch.requestPaused", sessionId, ({ requestId, request }) => {
      if (request.url !== FINGERPRINT_URL) return void page("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
      intercepted = true;
      const body = Buffer.from("<!doctype html><title>Fingerprint</title>").toString("base64");
      void page("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }], body }).catch(() => {});
    });
    await page("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await page("Page.enable");
    const loaded = cdp.once("Page.domContentEventFired", sessionId);
    loaded.catch(() => {});
    if ((await page("Page.navigate", { url: FINGERPRINT_URL })).errorText) throw new Error("fingerprint navigation failed");
    await loaded;
    if (!intercepted) throw new Error("fingerprint document was not fulfilled locally");
    const { result, exceptionDetails } = await page("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error("fingerprint probe failed");
    return result?.value;
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }, undefined, true).catch(() => {});
    cdp.close();
  }
}
