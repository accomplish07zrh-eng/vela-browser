const MAX_ENTRIES = 200;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"]);
const validTime = value => Number.isFinite(value) && value >= 0;
const span = (start, end) => validTime(start) && validTime(end) && end >= start ? end - start : -1;

function timingsFor(timing = {}) {
  const { domainLookupStart, domainLookupEnd, connectStart, connectEnd, secureConnectionStart,
    requestStart, responseStart, responseEnd } = timing ?? {};
  const start = Math.min(...[domainLookupStart, connectStart, requestStart].filter(validTime));
  const timings = {
    blocked: span(0, start), dns: span(domainLookupStart, domainLookupEnd),
    connect: span(connectStart, connectEnd), ssl: span(secureConnectionStart, connectEnd),
    send: -1, wait: span(requestStart, responseStart), receive: span(responseStart, responseEnd),
  };
  // TLS is part of connect. Playwright does not give a separate upload duration.
  const time = Object.entries(timings).reduce((total, [phase, ms]) => total + (phase === "ssl" ? 0 : Math.max(ms, 0)), 0);
  return { time, timings };
}

/** Build a shareable HAR from retained metadata. No header, body, URL string or error text is exported. */
export function sanitizedHar(records, requestedLimit = MAX_ENTRIES) {
  const limit = Math.min(MAX_ENTRIES, Math.max(1, requestedLimit));
  const selected = records.slice(0, limit);
  const origins = new Map(), destinations = new Map(), requests = new Map();
  const alias = value => {
    let url;
    try { url = new URL(value); } catch { return "https://unknown.invalid/"; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "https://unknown.invalid/";
    if (!origins.has(url.origin)) origins.set(url.origin, origins.size + 1);
    const key = url.origin + url.pathname;
    if (!destinations.has(key)) destinations.set(key, destinations.size + 1);
    return `${url.protocol}//site-${origins.get(url.origin)}.invalid/request-${destinations.get(key)}`;
  };
  for (const [index, item] of selected.entries()) requests.set(item.requestId, { index: index + 1, url: alias(item.url) });
  const nextHops = new Map(selected.filter(item => item.redirectedFrom).map(item => [item.redirectedFrom, item]));
  const entries = selected.map((item, index) => {
    const { index: hop, url } = requests.get(item.requestId) ?? { index: index + 1, url: alias(item.url) };
    const { timings, time } = timingsFor(item.timing);
    const browserStart = item.timing?.startTime;
    const started = validTime(browserStart) && browserStart > 0 ? browserStart : Date.parse(item.timestamp);
    const status = Number.isInteger(item.status) && item.status >= 100 && item.status <= 599 ? item.status : 0;
    const redirect = nextHops.get(item.requestId);
    return {
      startedDateTime: new Date(validTime(started) && started <= 8.64e15 ? started : 0).toISOString(), time,
      request: { method: METHODS.has(item.method) ? item.method : "OTHER", url, httpVersion: "",
        cookies: [], headers: [], queryString: [], headersSize: -1, bodySize: -1 },
      response: { status, statusText: "", httpVersion: "", cookies: [], headers: [], content: { size: 0, mimeType: "" },
        redirectURL: redirect ? requests.get(redirect.requestId)?.url ?? "" : "", headersSize: -1, bodySize: -1 },
      cache: {}, timings,
      _vela: { hop, redirectedFrom: requests.get(item.redirectedFrom)?.index ?? null,
        state: item.state === "failed" ? "failed" : item.state === "finished" ? "finished" : "pending" },
    };
  });
  return { log: { version: "1.2", creator: { name: "Vela Browser", version: "1" }, entries },
    _vela: { sanitized: true, count: entries.length, hasMore: records.length > selected.length } };
}
