import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";

/**
 * Watching from a phone on the same network: which browsers run, a small picture of each, and
 * how scripts and tasks are going. Read only. It is its own listener, separate from the
 * dashboard and the local API, so nothing else of Vela Browser is reachable from the network.
 * The phone enters a six-digit PIN shown in Settings; wrong guesses are slowed and then refused.
 */
export interface MobileProfile { id: string; name: string; group: string; running: boolean; engine?: string }
export interface MobileSource {
  profiles(): MobileProfile[];
  snapshot(id: string): Promise<{ frame: { data: string }; title: string; url: string } | null>;
  activity(): { script?: { name: string; done: number; total: number; failed: number } | null; task?: { name: string } | null };
}

const SESSION_MS = 12 * 3600_000;
const FRAME_CACHE_MS = 3000;
const VIRTUAL = /tun|tap|wintun|utun|clash|meta|mihomo|sing-?box|wireguard|tailscale|zerotier|vpn|vethernet|hyper-v|vmware|virtualbox|docker|wsl|loopback/i;

/** The addresses a phone on the same network can reach: private IPv4 of physical adapters. */
export function lanAddresses(): string[] {
  const out: Array<{ address: string; rank: number }> = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    // Wired and Wi-Fi adapters first; Windows' hotspot connections ("… * 10") last, in case the phone is on the hotspot.
    const rank = /wlan|wi-?fi|ethernet|以太网|^en\d|^eth\d|^wl/i.test(name) ? 0 : name.includes("*") ? 2 : 1;
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)) out.push({ address: address.address, rank });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((item) => item.address);
}

export class MobileView {
  private server?: ReturnType<typeof Bun.serve>;
  private pin = "";
  private sessions = new Map<string, number>();
  private attempts = new Map<string, { count: number; first: number; total: number }>();
  private frames = new Map<string, { at: number; image: Buffer | null; title: string; host: string }>();

  constructor(private readonly source: MobileSource, private readonly now: () => number = Date.now) {}

  get running(): boolean { return !!this.server; }
  get port(): number | undefined { return this.server?.port; }
  get currentPin(): string { return this.pin; }

  /** Starts listening (port 50480, or any free one), with a fresh PIN and no sessions. */
  start(preferredPort = 50480): void {
    this.stop();
    this.pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const options = { hostname: "0.0.0.0", fetch: (req: Request, server: any) => this.handle(req, server?.requestIP?.(req)?.address ?? "?") };
    try { this.server = Bun.serve({ ...options, port: preferredPort }); }
    catch { this.server = Bun.serve({ ...options, port: 0 }); }
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
    this.sessions.clear(); this.attempts.clear(); this.frames.clear();
  }

  /** A new PIN; phones already signed in stay signed in. */
  newPin(): string { this.pin = String(randomInt(0, 1_000_000)).padStart(6, "0"); this.attempts.clear(); return this.pin; }

  private session(req: Request): boolean {
    const token = /(?:^|;\s*)vela_m=([a-f0-9]{48})/.exec(req.headers.get("cookie") ?? "")?.[1];
    const expires = token ? this.sessions.get(token) : undefined;
    if (!token || !expires) return false;
    if (expires < this.now()) { this.sessions.delete(token); return false; }
    return true;
  }

  /** Five tries a minute per address, and none after twenty wrong ones until a new PIN. */
  private allowAttempt(ip: string): boolean {
    const now = this.now();
    const entry = this.attempts.get(ip) ?? { count: 0, first: now, total: 0 };
    if (now - entry.first > 60_000) { entry.count = 0; entry.first = now; }
    this.attempts.set(ip, entry);
    return entry.count < 5 && entry.total < 20;
  }

  async handle(req: Request, ip: string): Promise<Response> {
    const url = new URL(req.url);
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
    if (url.pathname === "/login" && req.method === "POST") {
      if (!this.allowAttempt(ip)) return new Response(JSON.stringify({ ok: false, error: "Too many tries. Wait a minute, or show a new PIN in Vela Browser." }), { status: 429, headers: { ...headers, "Content-Type": "application/json" } });
      const body = await req.json().catch(() => ({})) as { pin?: unknown };
      const given = Buffer.from(String(body.pin ?? "").trim().padEnd(6, " ").slice(0, 6)), want = Buffer.from(this.pin);
      if (!this.pin || given.length !== want.length || !timingSafeEqual(given, want)) {
        const entry = this.attempts.get(ip)!; entry.count++; entry.total++;
        return new Response(JSON.stringify({ ok: false, error: "Wrong PIN" }), { status: 401, headers: { ...headers, "Content-Type": "application/json" } });
      }
      this.attempts.delete(ip);
      const token = randomBytes(24).toString("hex");
      this.sessions.set(token, this.now() + SESSION_MS);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...headers, "Content-Type": "application/json", "Set-Cookie": `vela_m=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` } });
    }
    if (req.method !== "GET") return new Response("Read only", { status: 405, headers });
    if (url.pathname === "/") return new Response(this.session(req) ? MOBILE_PAGE : PIN_PAGE, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" } });
    if (!this.session(req)) return new Response("Sign in with the PIN first", { status: 401, headers });
    if (url.pathname === "/state") {
      const profiles = this.source.profiles().filter((profile) => profile.running).map((profile) => {
        const cached = this.frames.get(profile.id);
        return { id: profile.id, name: profile.name, group: profile.group, engine: profile.engine ?? "chromium", title: cached?.title ?? "", host: cached?.host ?? "" };
      });
      return new Response(JSON.stringify({ ok: true, at: this.now(), profiles, total: this.source.profiles().length, ...this.source.activity() }), { headers: { ...headers, "Content-Type": "application/json" } });
    }
    const frame = /^\/frame\/([A-Za-z0-9_-]{1,80})$/.exec(url.pathname);
    if (frame) {
      const id = frame[1]!;
      if (!this.source.profiles().some((profile) => profile.id === id && profile.running)) return new Response("Not running", { status: 404, headers });
      let cached = this.frames.get(id);
      if (!cached || this.now() - cached.at > FRAME_CACHE_MS) {
        const shot = await this.source.snapshot(id).catch(() => null);
        let host = "";
        try { host = shot?.url ? new URL(shot.url).hostname : ""; } catch { host = ""; }
        cached = { at: this.now(), image: shot ? Buffer.from(shot.frame.data, "base64") : null, title: shot?.title ?? "", host };
        this.frames.set(id, cached);
      }
      if (!cached.image) return new Response("No picture yet", { status: 404, headers });
      return new Response(new Uint8Array(cached.image), { headers: { ...headers, "Content-Type": "image/jpeg" } });
    }
    return new Response("Not found", { status: 404, headers });
  }
}

const STYLE = `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark">
<style>
:root{--bg:#f6f3ec;--card:#fffdf8;--ink:#2b2317;--muted:#8a8172;--line:#e8e1d3;--accent:#8c6d3f;--ok:#4f8a5b;--bad:#b94a36}
@media (prefers-color-scheme:dark){:root{--bg:#141210;--card:#1f1c18;--ink:#ece6da;--muted:#9a917f;--line:#2e2a24;--accent:#d6b47a;--ok:#7fb48a;--bad:#d98c78}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:16px 16px calc(24px + env(safe-area-inset-bottom))}
h1{font-size:20px;margin:6px 0 2px}p.sub{margin:0 0 16px;color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;margin-bottom:14px}
.card img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;background:var(--line)}
.meta{padding:10px 12px}.meta b{display:block;font-size:15px}.meta span{color:var(--muted);font-size:12.5px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:14px;font-size:14px}
.bar i{display:block;height:6px;border-radius:3px;background:var(--line);margin-top:8px;overflow:hidden}.bar i b{display:block;height:100%;background:var(--accent)}
.empty{color:var(--muted);text-align:center;padding:48px 0}
input{width:100%;font-size:28px;letter-spacing:.4em;text-align:center;padding:14px;border-radius:14px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button{width:100%;margin-top:12px;font-size:16px;padding:14px;border:0;border-radius:14px;background:var(--ink);color:var(--bg)}
.err{color:var(--bad);font-size:13px;min-height:20px;margin-top:8px}
</style>`;

// Written in Chinese with an English line under it: this page has no language switch of its own.
const PIN_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Vela Browser</title>${STYLE}</head><body>
<h1>Vela Browser</h1><p class="sub">输入电脑上「设置 → 数据与安全 → 手机查看」显示的 PIN<br>Enter the PIN shown on the computer</p>
<form id="f"><input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" autofocus><button>查看 · View</button><div class="err" id="e"></div></form>
<script>
document.getElementById("f").onsubmit=async(ev)=>{ev.preventDefault();const r=await fetch("/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pin:document.getElementById("pin").value})});
if(r.ok){location.reload();}else{const b=await r.json().catch(()=>({}));document.getElementById("e").textContent=b.error==="Wrong PIN"?"PIN 不对 · Wrong PIN":"试太多次了，请稍等，或在电脑上换一个 PIN · Too many tries";}};
</script></body></html>`;

const MOBILE_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Vela Browser</title>${STYLE}</head><body>
<h1>正在运行 · Running</h1><p class="sub" id="sub">…</p><div id="activity"></div><div id="list"></div>
<script>
const esc=(s)=>String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let tick=0;
async function load(){
  let s;try{const r=await fetch("/state",{cache:"no-store"});if(r.status===401){location.reload();return;}s=await r.json();}catch{document.getElementById("sub").textContent="连接中断，重试中… · Reconnecting";return;}
  tick++;
  document.getElementById("sub").textContent=s.profiles.length+" 个运行中，共 "+s.total+" 个环境 · "+new Date(s.at).toLocaleTimeString();
  let a="";
  if(s.script){const p=s.script.total?Math.round(100*s.script.done/s.script.total):0;a+='<div class="bar">脚本 · '+esc(s.script.name)+'：'+s.script.done+'/'+s.script.total+(s.script.failed?'，失败 '+s.script.failed:'')+'<i><b style="width:'+p+'%"></b></i></div>';}
  if(s.task){a+='<div class="bar">自动任务进行中 · '+esc(s.task.name)+'</div>';}
  document.getElementById("activity").innerHTML=a;
  document.getElementById("list").innerHTML=s.profiles.length?s.profiles.map((p)=>'<div class="card"><img loading="lazy" src="/frame/'+encodeURIComponent(p.id)+'?t='+Math.floor(tick/2)+'" alt=""><div class="meta"><b>'+esc(p.name)+'</b><span>'+esc([p.group,p.title||p.host].filter(Boolean).join(" · "))+'</span></div></div>').join(""):'<div class="empty">现在没有运行中的环境<br>No browser is running</div>';
}
load();setInterval(()=>{if(!document.hidden)load();},2500);
</script></body></html>`;
