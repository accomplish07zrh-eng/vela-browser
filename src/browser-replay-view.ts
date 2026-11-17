import { createHash } from "node:crypto";
import { BROWSER_REPLAY_PATH, type BrowserReplay } from "./browser-replay.ts";

const player = `
const image = document.querySelector('img');
const seek = document.querySelector('input');
const play = document.querySelector('button');
const status = document.querySelector('[role=status]');
const time = document.querySelector('output');
const token = location.hash.slice(1);
const request = { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } };
const timelineUrl = location.pathname + '/frames';
const loadedAt = performance.now();
let frames = [], first = 0, lastTick = loadedAt;
let playing = false, pending = false, desired, shown, imageUrl, timer;
let lastRequest = 0, retryAt = 0;

function clearImage() {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = undefined;
  shown = undefined;
  image.removeAttribute('src');
  image.hidden = true;
}
function setPlaying(value) {
  playing = value;
  play.textContent = playing ? 'Pause' : 'Play';
}
function expired() {
  setPlaying(false);
  clearInterval(timer);
  desired = undefined;
  clearImage();
  play.disabled = seek.disabled = true;
  status.textContent = 'This replay has expired or ended.';
}
async function show(frame, verify = false) {
  pending = true;
  lastRequest = performance.now();
  try {
    const result = await fetch(timelineUrl + '/' + frame.id, verify ? { ...request, method: 'HEAD' } : request);
    if (result.status === 404) {
      clearImage();
      const timeline = await fetch(timelineUrl, request);
      if (!timeline.ok) { expired(); return; }
      first = Math.max(first, frames.indexOf(frame) + 1);
      return;
    }
    if (!result.ok) throw new Error();
    if (verify) return;
    const jpeg = await result.blob();
    if (desired !== frame || performance.now() - loadedAt >= frame.remainingMs) return;
    clearImage();
    imageUrl = URL.createObjectURL(jpeg);
    image.src = imageUrl;
    image.hidden = false;
    shown = frame;
    status.textContent = '';
  } catch {
    setPlaying(false);
    retryAt = performance.now() + 750;
    status.textContent = 'Waiting for the replay…';
  } finally { pending = false; }
}
function tick() {
  if (document.hidden) return;
  const now = performance.now(), age = now - loadedAt;
  if (shown && age >= shown.remainingMs) clearImage();
  // Leave time to fetch the next JPEG before its server-side expiration.
  while (first < frames.length && age + 250 >= frames[first].remainingMs) first++;
  if (first === frames.length) { desired = undefined; expired(); return; }
  const start = frames[first].offsetMs;
  const end = frames.at(-1).offsetMs;
  const position = Math.max(start, Number(seek.value)) + (playing ? now - lastTick : 0);
  seek.min = start;
  seek.value = Math.min(position, end);
  lastTick = now;
  if (position >= end) setPlaying(false);
  time.value = (Number(seek.value) / 1000).toFixed(1) + ' s';
  let index = first;
  while (index + 1 < frames.length && frames[index + 1].offsetMs <= Number(seek.value)) index++;
  desired = frames[index];
  if (pending || now < retryAt) return;
  if (desired !== shown) void show(desired);
  else if (now - lastRequest >= 1000) void show(desired, true);
}
play.addEventListener('click', () => {
  if (playing) setPlaying(false);
  else {
    if (Number(seek.value) >= Number(seek.max)) seek.value = seek.min;
    lastTick = performance.now();
    setPlaying(true);
  }
  tick();
});
seek.addEventListener('input', () => { setPlaying(false); tick(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { setPlaying(false); desired = undefined; clearImage(); }
});
addEventListener('pagehide', () => { desired = undefined; clearInterval(timer); clearImage(); });

async function load() {
  if (!/^[a-f0-9-]{36}$/.test(token)) { expired(); return; }
  try {
    const result = await fetch(timelineUrl, request);
    if (!result.ok) { expired(); return; }
    frames = await result.json();
    seek.max = frames.at(-1).offsetMs;
    seek.min = seek.value = frames[0].offsetMs;
    play.disabled = seek.disabled = frames.length < 2;
    timer = setInterval(tick, 60);
    tick();
  } catch { expired(); }
}
void load();
`;

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'sha256-" + createHash("sha256").update(player).digest("base64")
    + "'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vela Browser replay</title>
<style>
  :root { color-scheme: dark; font: 16px Inter, system-ui, sans-serif; background: #17191f; color: #f0f2f6; }
  body { max-width: 72rem; margin: auto; padding: 1.25rem; }
  h1 { font-size: 1.2rem; margin: 0 0 1rem; font-weight: 600; }
  figure { margin: 0; min-height: 12rem; height: min(70vh, 46rem); display: grid; place-items: center; background: #0b0d11; border: 1px solid #313540; border-radius: .6rem; overflow: hidden; }
  img { max-height: 100%; max-width: 100%; min-height: 0; object-fit: contain; }
  figure > * { grid-area: 1 / 1; }
  [role=status] { color: #b9bfcb; }
  section { display: flex; align-items: center; gap: .8rem; padding-top: .8rem; }
  button { min-width: 5rem; padding: .5rem .8rem; font: inherit; border: 1px solid #525d74; border-radius: .45rem; background: #2b3446; color: inherit; }
  button:disabled { opacity: .5; }
  input { flex: 1; min-width: 0; accent-color: #aac5ff; }
  output { min-width: 4.3rem; text-align: right; font-variant-numeric: tabular-nums; }
</style>
<h1>Vela Browser replay</h1>
<figure><img alt="Recorded browser tab" hidden><span role="status">Loading replay…</span></figure>
<section><button type="button" disabled>Play</button>
<input aria-label="Replay position" type="range" min="0" max="0" step="any" value="0" disabled><output></output></section>
<script>${player}</script>
</html>`;

export function browserReplayView(req: Request, path: string, replay: BrowserReplay): Response {
  const headers = securityHeaders;
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  if (path === BROWSER_REPLAY_PATH) {
    return new Response(req.method === "HEAD" ? null : html, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }
  const match = /^\/ui\/replay\/frames(?:\/([1-9]\d{0,11}))?$/.exec(path);
  const token = /^Bearer ([a-f0-9-]{36})$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const data = match && replay.read(token, match[1] ? Number(match[1]) : undefined);
  if (!data) return new Response(null, { status: 404, headers });
  return Buffer.isBuffer(data)
    ? new Response(req.method === "HEAD" ? null : data, { headers: { ...headers, "Content-Type": "image/jpeg" } })
    : req.method === "HEAD" ? new Response(null, { headers }) : Response.json(data, { headers });
}
