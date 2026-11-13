# 代理订阅导入 · 全局代理池 · 运行中换代理 设计稿

2026-11-13 · 草稿，等用户认可后再动产品代码。

## 0. 结论先说

- **能做，而且不需要放松隔离。** 现有架构里每个环境都有自己的本机中继（`src/proxy-relay.ts`），浏览器只连 `127.0.0.1:<中继端口>`。订阅节点、代理池、运行中换代理，都可以挂在这个中继后面实现，浏览器那一侧什么都不用变。
- **只影响对应环境，不碰电脑全局。** 不开 TUN 虚拟网卡，不设系统代理，不改路由表。协议内核只在 127.0.0.1 上为对应环境的中继开端口，其他软件感知不到。验收里专门有一项检查"全局没被改"（§8.4）。
- **订阅协议靠 sing-box 内核（最低 1.12.0，AnyTLS 需要），每个用订阅节点的环境起一个内核进程。** 订阅里的 `direct` / `reject` 这类非出口条目一律跳过，绝不会被当成节点分配出去。 共享内核看起来省内存，但热切换时要整体重载配置，会把所有环境的连接一起断掉；一个进程崩了也是全体断网；多个环境的流量还可能被多路复用进同一条到节点的连接。按环境分进程，每个约 20–40 MB，和 Chromium 每个环境几百 MB 比起来不算大。
- **运行中换代理 = 把启动时按出口定的那两样东西（时区、WebRTC 公网地址）在运行中按新出口重定一遍，然后刷新页面。** 不限制只能换同地区节点，换完也不弹重启提示（按用户要求）。中继在切换期间只有三种状态：用旧上游转发、暂存新连接不转发、用新上游转发。没有任何一条代码路径会直连。
- **哪些内核能真正热换：** Vela Chromium 155、Vela Firefox 是我们自己编的内核，加一个运行中更新时区和 WebRTC 地址的接口就行（见 §5.4）。CloakBrowser（第三方二进制）和 WebKit 改不了运行中的时区，这两种内核换代理时由 Vela 自动保存会话、重开、恢复标签页。用户看到的是"窗口闪一下，标签页都回来了"，不用自己操作。
- **MCP 加三个工具：** `vela_proxy_pool_list`、`vela_proxy_pool_check`、`vela_browser_set_proxy`。换出口会影响账号风控，默认每次在 Vela 界面里请用户点"允许"；用户可以按 MCP 连接改成"池内节点直接放行"。

---

## 1. 现状（读代码得到的事实）

| 事实 | 位置 |
| --- | --- |
| `ProxyType` 只有 `http` / `https` / `socks5`，所有入口必须过 `normalizeProxySpec`，未知类型直接拒绝 | `src/types.ts:25`、`src/proxy.ts` |
| 中继只在"需要时"才起：WebKit 全部、SOCKS5 全部、带账号的 HTTP。**无认证的 HTTP / HTTPS 代理在 Chromium 和 Firefox 上是直接写进 `--proxy-server` 的，不经过中继** | `src/launcher.ts:102` `needsProxyRelay`、`:1558`、`:2830` |
| 中继跟踪所有客户端和上游 socket，`close()` 时全部 destroy | `src/proxy-relay.ts:50-80` |
| 中继发给上游的都是**域名**：HTTP 上游用 `CONNECT host:port`，SOCKS5 上游用 ATYP=3（域名）。目标域名在本机不解析 | `src/proxy-relay.ts`、`src/geoip.ts:101` |
| 每次启动经代理查一次出口：时区写回环境（用户手填的时区除外），出口 IP 作为 Vela Firefox / Chromium 155 的 WebRTC 公网地址 | `src/launcher.ts:2119-2136`、`:664`、`:1455` |
| 有代理的环境 WebRTC 策略是 `disable_non_proxied_udp`，直连环境是 `default_public_interface_only` | `src/launcher.ts:98` |
| 启动时的身份字段（含 `proxy`、`timezone`）记在 `LaunchInfo.persona`，并参与 `personaDigest`；运行中改环境只影响下次启动 | `src/launcher.ts:384` `LAUNCH_PERSONA_KEYS`、`src/types.ts:244` |
| 管理器重启后，浏览器还活着，中继按 `launch.relayPort` 原端口、按**启动时的代理**重新绑定 | `src/launcher.ts:3623` `ensureSurvivorRelay` |
| 批量换代理对运行中的环境返回 `profile_open` 跳过 | `src/proxy-bulk.ts` `replacementState` |
| 代理检测：经同一个中继访问出口查询服务 3 次，出口 IP 等于本机直连 IP 判为 `proxy_bypassed` | `src/proxy-check.ts` |
| 所有中继都跑在管理器的 Bun 进程里 | `src/launcher.ts:4410` 注释 |
| MCP 工具命名 `vela_<对象>_<动作>`，经 `runtime.call("<域>.<动作>")` 进 `src/agent-control.ts` | `agent/mcp-host.mjs:89-220`、`src/agent-control.ts:259` |
| 下载的运行时按源码里写死的 SHA-256 校验，并支持断点续传 | `src/browser-install.ts:45`、`src/runtime-download.ts` |

由此得到两个前提：

1. **运行中换代理，要求这个环境启动时就经过中继。** 所以第一阶段先改成"有代理的环境一律走中继"（§9 阶段 0）。
2. **直连环境不能在运行中换成代理，反过来也不行。** 原因不是地区，是 WebRTC 策略：直连环境启动时用的是 `default_public_interface_only`，会把本机网卡地址交给 WebRTC。运行中给它挂上代理，WebRTC 仍会从本机网卡发 UDP，等于泄露真实 IP。这种情况一律自动重开（同 CloakBrowser 的做法），不做热换。

---

## 2. 订阅导入

### 2.1 拉取

- 用户在界面里填订阅链接。链接本身就是凭据，存储时与环境代理密码同等对待（Windows 走现有 `src/dpapi.ts`），日志和界面只显示主机名。
- 从本机直接拉取（订阅服务商看到真实 IP 是正常的，它不是账号网站）。可以在订阅上指定"经某个已有代理拉取"。
- 限制：只允许 https（http 需用户确认）、响应体最大 5 MB、超时 20 s、最多 3 次重定向。
- **按 UA 取格式**：同一订阅会按 User-Agent 返回不同格式（三份测试订阅都是这样）。默认先用 `clash.meta` 拉 YAML，因为它的字段最全（`reality-opts`、`ws-opts`、`client-fingerprint` 等都在）。拉取失败或解析不出 `proxies` 时，再用 `v2rayN` 拉 base64 URI。用户也可以在订阅上固定 UA 或自定义 UA。
- **流量与到期**：读取响应头 `subscription-userinfo`（格式为 `upload=…; download=…; total=…; expire=…`，单位字节和 Unix 秒）。在订阅上显示已用、剩余流量和到期日；剩余不足 10% 或 7 天内到期时提醒。这个头缺失或格式不对时不显示，不报错。三份测试订阅都带这个头。
- 定时刷新可选（默认关）。刷新不会自动给正在使用的环境换节点，见 §2.4。

### 2.2 识别格式（按顺序尝试）

1. YAML，并且有 `proxies:` 列表，按 Clash / mihomo 处理。只读 `proxies`；`proxy-groups`（`select` / `url-test` / `fallback` / `load-balance` 等）、`rules` 一律忽略，因为每个环境只有一个固定出口，不做按规则分流，也不做自动选优。
   - `proxies` 里的**非出口类型**，包括 `direct`、`reject`、`reject-drop`、`dns`、`pass`、`compatible` 以及分组引用，一律跳过并计为"非节点"，导入报告里列出数量。**它们绝不能被导入成可以分配给环境的节点**：`direct` 等于让环境直连，`reject` 等于断网。sing-box JSON 和 URI 列表里的 `direct` / `block` / `dns` 出站同样处理。
   - 判断用白名单：只有 §2.3 表里列出的协议才可能成为节点，其他类型一律落到"不支持"或"非节点"，不存在"默认当成节点"的分支。
2. JSON，并且有 `outbounds`，按 sing-box 配置处理。
3. 整体 base64（标准 / URL-safe，容忍缺 padding 和换行）解码后逐行解析 URI。
4. 明文逐行 URI。
5. 现有的 `host:port:user:pass` 行（复用 `parseProxySpec`）。

### 2.3 节点解析规则

| 协议 | Clash 字段 / URI 形式 | 备注 |
| --- | --- | --- |
| http / https / socks5 | `type: http/socks5`；`http://` `https://` `socks5://` | 不经内核，直接走现有中继 |
| Shadowsocks | `type: ss`；SIP002 `ss://base64(method:pass)@host:port#name`，以及旧式整段 base64 | 插件 `obfs` / `v2ray-plugin` 映射到 sing-box 的 plugin 字段 |
| VMess | `type: vmess`；`vmess://base64(v2rayN JSON)` | `network` 为 ws / grpc / h2 / http 时映射成 transport |
| VLESS | `type: vless`；`vless://uuid@host:port?…#name` | 支持 `flow=xtls-rprx-vision`、`security=reality`（`pbk` / `sid` / `sni` / `fp`） |
| Trojan | `type: trojan`；`trojan://pass@host:port?sni=…#name` | |
| Hysteria2 | `type: hysteria2`；`hysteria2://` 或 `hy2://pass@host:port?sni&obfs&obfs-password#name` | 走 QUIC；这条 UDP 是**内核到节点服务器**的，不是浏览器发出的 |
| TUIC | `type: tuic`；`tuic://uuid:pass@host:port?…` | 同上 |
| AnyTLS | `type: anytls`，字段 `password`、`sni`、`client-fingerprint`、`skip-cert-verify`、`alpn`、`idle-session-check-interval`、`idle-session-timeout`、`min-idle-session`；`anytls://pass@host:port?sni=…&insecure=…#name` | 映射到 sing-box 的 `anytls` 出站（**sing-box 1.12.0 起支持**）。`client-fingerprint` 对应 `tls.utls.fingerprint`，`idle-session-*` 对应同名的 `idle_session_*`。测试订阅 2 全是 anytls，不支持它就等于整份订阅不能用 |
| 其他（ssr、wireguard、snell 等） | | 记为"不支持"并写明原因，不静默丢掉 |

解析时的硬规定：

- **任何字段不认识，就整条节点标"不支持"**，不能删掉这个字段勉强导入。少了一个 transport 或 TLS 参数，节点行为就变了，可能连到别处，也可能明文传输。
- `skip-cert-verify: true` / `allowInsecure=1` 照原样导入，但节点要标"不验证证书"。到节点这一段可能被中间人截获；浏览器到网站的 TLS 仍然是端到端的，不受影响。
- 服务商塞进来的信息条目标记为信息，不算节点，也不会被分配出去。识别规则（任一条命中即可）：
  - 服务器是 `127.0.0.1` / `0.0.0.0` / `::` / `localhost`，或者端口是 0 / 1；
  - 节点名含关键词：`剩余流量`、`流量`、`到期`、`过期`、`有效期`、`官网`、`网址`、`套餐`、`重置`、`客服`、`群`、`公告`、`Traffic`、`Expire`、`Website` 等。关键词表放在一个常量里，方便补充。
  - 三份测试订阅都没有回环地址的信息条目，信息全写在节点名里，所以关键词这一条是主要手段。
  - 关键词判断可能误伤真节点（比如名字里碰巧有"群"字），所以信息条目放在导入报告的单独一栏，用户可以手动改回节点。导入时永远不会把它当成可用节点。
- 服务器地址是内网或回环地址的节点要提示，但允许导入，因为可能是用户自己局域网里的代理。
- 去重键：`协议 + 服务器 + 端口 + 凭据哈希`。同一节点出现在两个订阅里时只存一份，记两个来源。

### 2.4 订阅刷新时节点变了怎么办

- 节点不在新订阅里了：标"已从订阅移除"。正在用它的环境**继续用旧快照**，界面提示用户换一个。不自动替换，因为替换就是换出口，会影响账号风控。
- 节点参数变了（例如服务商换了密码）：生成新版本，旧版本保留到没有环境引用为止。运行中的环境用启动或切换时的快照，与 `LaunchInfo.persona` 的规则一致。

---

## 3. 协议内核

### 3.1 选 sing-box

| | sing-box | mihomo |
| --- | --- | --- |
| 协议覆盖 | vmess / vless（含 reality、vision）/ trojan / ss / hysteria2 / tuic / anytls（1.12.0 起） | 同等，且原生读 Clash YAML |
| 配置 | 严格 JSON，字段明确，适合程序生成后校验 | YAML，兼容历史写法多，宽松 |
| 运行时控制 | 有 Clash 兼容 API，但本方案不依赖 | REST API 完整 |
| 许可 | GPL-3.0-or-later | GPL-3.0 |

推荐 **sing-box，最低版本 1.12.0**：AnyTLS 出站从 1.12.0 开始才有。实施时选当时 1.12 及以上的最新稳定版，按那个版本写死各平台的哈希常量（§3.4）。以后升级内核版本时，要在 §8.1 测试台上把 vless-reality、vless-ws、hysteria2、anytls 都跑一遍再换常量。我们自己把订阅解析成中立的节点模型，再生成内核配置，所以"原生读 Clash YAML"不是优势；严格的 JSON 更容易验证"生成的配置里没有直连出站"。两者都是 GPL，作为独立可执行文件分发、不链接进 Vela，并在 `NOTICE` 中附源码地址。**实施前需要再确认一次许可证条款。**

### 3.2 每环境一个进程，还是一个共享进程

| | 每环境一个内核进程（推荐） | 一个共享内核，每环境独立入站→指定出站 |
| --- | --- | --- |
| 环境之间的隔离 | 进程级。A 的配置、连接、内存与 B 完全分开 | 靠配置生成的正确性；入站与出站对错一处，A 的流量就会走 B 的出口 |
| 多路复用 | 不存在跨环境复用 | 两个环境用同一节点时，mux、hysteria2、tuic 可能把两边的流量放进同一条到节点的连接，节点那端能把两个环境关联起来 |
| 运行中换节点 | 起一个新进程，中继切过去，杀掉旧进程，别的环境毫无感知 | sing-box 不支持只重载一部分配置，整体重载会断掉**所有**环境的连接；改用 selector 则要把整个池塞进每个环境的配置 |
| 崩溃影响面 | 一个环境断网（关闭式失败，不直连），看门狗自动拉起 | 全部用订阅节点的环境同时断网 |
| 资源 | 每个约 20–40 MB 常驻内存，启动约 100–300 ms | 一个进程，内存更少 |
| 适用范围 | 只有用订阅协议节点的环境才起内核；http / socks5 节点照旧直接走中继 | |

20 个环境同时开着时，内核总共大约 0.5 GB，而浏览器本身是每个 300 MB 以上，占比可以接受。推荐每环境一个进程。

批量健康检测（§4.3）不承载账号流量，可以用一个**检测专用**的共享内核进程，一次开 N 个入站对应 N 个节点。检测结束后立刻退出。

### 3.3 生成的内核配置（不变量）

每个环境的配置只有这些内容，生成后由代码断言：

```jsonc
{
  "log": { "level": "warn" },
  "inbounds": [{
    "type": "socks", "tag": "in",
    "listen": "127.0.0.1", "listen_port": 0,            // 端口由 Vela 预先分配并传入
    "users": [{ "username": "<随机>", "password": "<随机>" }]   // 只有本环境的中继知道
  }],
  "outbounds": [
    { "type": "<vless|trojan|…>", "tag": "node", /* 节点参数，不开 multiplex */ },
    { "type": "block", "tag": "deny" }
  ],
  "route": { "rules": [{ "inbound": ["in"], "outbound": "node" }], "final": "deny" }
}
```

- **配置里不出现 `direct` 出站**。内核要连到节点服务器，靠的是节点出站自己的拨号，不需要 direct。
- 不开 `tun`、`set_system_proxy`、`auto_route`，不开 `sniff` 和 `sniff_override_destination`。内核原样转发中继给的域名，不在本机解析目标域名，也不读、不改浏览器的 TLS。
- 本机只解析一个名字：**节点服务器自己的域名**。今天直接用 http / socks5 代理时也是这样，没有新增暴露。
  - 这一个名字也不走运营商的明文 DNS：节点出站设 `domain_resolver`，指向一个只用来解析节点服务器的 DoH 服务器（可配置）。这是借鉴 Clash Verge 的 `proxy-server-nameserver` 做法。目标网站的名字照旧一个都不在本机解析。
  - sing-box 配置里，除了这个专用 DoH 服务器，不配置任何其他 `dns.servers` 和 `dns.rules`；断言里写死这一点。
- 入站带随机账号密码。现在中继端口不带认证，同机其他进程理论上能连上；内核入站至少不扩大这个面。中继端口要不要也加防护，另列跟进项。
- 中继接内核时，就把内核当成一个普通 SOCKS5 上游：`{type: "socks5", host: "127.0.0.1", port, user, pass}`。`startProxyRelay` 已经支持带认证的 SOCKS5，中继代码几乎不用改。

### 3.4 分发、校验、更新

- **首次用到才下载**：第一次导入含非 http / socks5 节点的订阅时下载，复用 `src/runtime-download.ts` 的断点续传。装到应用数据目录下 `runtimes/sing-box/<版本>/`，不加大安装包。
- **哈希写死在源码里**：每个平台（win-x64、mac-arm64 / x64、linux-x64）的归档和可执行文件 SHA-256 都写成常量，做法同 `CLOAKBROWSER_WINDOWS_X64_*_SHA256`。每次启动内核进程前重新校验可执行文件哈希，不一致就拒绝启动这个环境。
- **只随 Vela 发版更新**：换内核版本 = 改常量 + 发 Vela 新版。不做内核自更新，保证同一个 Vela 版本跑的永远是同一个内核。旧版本在没有进程使用时清理。
- Windows Defender 偶尔会误报代理内核。安装失败时要给出明确提示，不允许静默降级。

---

## 4. 全局代理池

### 4.1 数据模型（SQLite，`src/store.ts`）

```ts
interface ProxySubscription {
  id: string; name: string;
  url: string;                 // 加密存储，日志与界面只显示主机名
  userAgent?: string;          // 缺省：先 clash.meta，失败再 v2rayN（§2.1）
  viaProxyNodeId?: string;
  refreshHours?: number; lastFetchedAt?: number; lastError?: string;
  kind: "provider" | "manual"; // 机场订阅 / 手动添加，决定默认共享策略（§4.4）
  usage?: {                    // 来自 subscription-userinfo 响应头
    uploadBytes?: number; downloadBytes?: number; totalBytes?: number;
    expireAt?: number;         // Unix 秒；0 或缺失 = 不显示
    readAt: number;
  };
  lastImport?: { nodes: number; unsupported: number; nonNodes: number; infoEntries: number };
}

interface ProxyNode {
  id: string;                  // 稳定 id，环境引用它
  version: number;             // 参数变化 +1，旧版本保留到无引用
  sourceIds: string[];         // 来自哪些订阅；手动添加为空
  name: string;
  protocol: "http" | "https" | "socks5" | "ss" | "vmess" | "vless" | "trojan" | "hysteria2" | "tuic" | "anytls";
  server: string; port: number;
  outbound: object;            // 规范化后的 sing-box 出站（不含 tag），机密字段加密
  tags: string[];              // 用户标签
  regionHint?: string;         // 从名称解析的地区（🇯🇵 / 日本 / JP）
  check?: {                    // 最近一次检测，地区以此为准
    status: "working" | "unstable" | "failed" | "unavailable";
    ip?: string; country?: string; city?: string; timezone?: string;
    latencyMs?: number; rotating?: boolean; checkedAt: number;
  };
  insecureTls?: boolean;       // skip-cert-verify
  maxProfiles?: number;        // 共享上限；缺省值按来源分档（§4.4）
  disabled?: boolean; removedFromSource?: boolean;
}
```

环境侧新增 `Profile.proxyNode?: { id: string; version: number }`，与现有 `proxy` 二选一：

- 选池内 http / socks5 节点时，同时写入 `proxy`（现有所有校验、导出、AdsPower 兼容照旧），`proxyNode` 只用来回溯来源。
- 选订阅协议节点时 `proxy` 为空，启动时由内核生成一个 127.0.0.1 的 SOCKS5 上游。
- `LAUNCH_PERSONA_KEYS` 加上 `proxyNode`，`LaunchInfo.persona` 里记节点快照的哈希。管理器重启后，按快照重起内核、重绑中继，与现在 `ensureSurvivorRelay` 的规则一致。

### 4.2 分组与地区

- 地区有两个来源：名称解析（提示）和真实出口检测（权威）。两者不一致时标黄，例如名字写"日本"、实际出口在新加坡。
- 池子页面按 订阅 / 实际国家 / 用户标签 / 健康状态 筛选。
- 现有"批量换代理"的输入多一种：从池里按筛选条件分配。

### 4.3 健康检测

- 复用 `src/proxy-check.ts` 的思路：经同样的中继、同样的出口查询服务检测 3 次，按现有的 `classifyProxyAttempts` 分类。出口等于本机直连 IP 判为 `proxy_bypassed`，节点直接标失败。
- 订阅节点多一跳："检测专用内核入站 → 中继 → 出口查询服务"。也就是说，检测走的链路和真实浏览时一样。
- 多记三项：延迟（建连到首字节）、出口时区（`lookupProxyExitLocation`）、是否轮换 IP（3 次出口不同就是 `rotating`）。
- 并发上限默认 8。检测只在用户操作或定时任务时进行，不偷偷持续探测（持续探测本身也会产生流量特征）。

### 4.4 一个节点分给几个环境

按节点来源分两档，作为默认值；用户可以对单个节点或分组改，最终的默认值由用户在 §10 拍板：

| 来源 | 默认 | 理由 |
| --- | --- | --- |
| 机场类订阅（`kind: "provider"`） | **可共享**，不设上限，但分配时、以及在环境卡片上都提示"与哪些环境共用这个出口" | 机场节点的出口本来就被成千上万人共用。在 Vela 里限制独占，既挡不住外面的人共用，也会让 100 个节点的订阅只能开 100 个环境 |
| 手动添加的节点（静态住宅、独享 IP 等，`kind: "manual"`） | **独占**，`maxProfiles = 1` | 这类 IP 通常只有你在用，两个账号共用一个 IP 很容易被风控关联 |

- 无论哪一档，界面都要能看出某个出口 IP 正被哪几个环境用着。以出口检测得到的 IP 为准，而不是以节点 id 为准，因为不同节点可能落在同一个出口。
- 超过上限时不能分配；在"可共享"档下分配给第二个环境时，只提示，不拦。
- **分配是粘性的**：节点失效时不自动换给环境另一个出口，只提示。自动换出口对账号来说是一次没人批准过的"异地登录"。
- 轮换型节点（`rotating`）单独标识。分给多个环境时额外提示：它们看起来是不同 IP，节点那一侧可能仍是同一个用户。

---

## 5. 什么时候换代理

### 5.1 启动前换（已关闭的环境）

改 `proxy` / `proxyNode` 后保存，下次启动沿用现有流程：查出口、写时区、定 WebRTC 地址。这一步不用新机制，只需让编辑框和批量工具支持池内节点。

### 5.2 运行中换：总体思路

启动时按出口决定的只有两样东西：**时区**（`--fingerprint-timezone` / Firefox `config.timezone`，用户手填的除外）和 **WebRTC 公网地址**（`--fingerprint-webrtc-ip` / Firefox 对应配置）。语言、UA、屏幕等不随出口变（现在的启动流程也不改它们），所以运行中换代理也只改这两样，改法和启动时一样，然后刷新页面。

**不限制地区，不提示重启**（用户要求）。换到不同地区之所以安全，是因为时区和 WebRTC 地址跟着新出口一起更新了，刷新后页面看到的 IP、时区、WebRTC 地址三者一致。

### 5.3 切换流程（每步都可以失败；失败一律退回旧出口或停止转发，绝不直连）

```
 0. 准入   环境在运行，且启动时走了中继；环境不在启动 / 关闭中（用 lifecycle-admission 拿锁）
           同一环境的两次切换互斥；直连环境 ↔ 代理之间的切换改走"自动重开"（§1 第 2 点）
 1. 准备   需要内核就先起新内核进程；经新上游查出口（IP、国家、时区）
           查不到出口 → 中止，什么都没改，旧出口继续用
 2. 截流   中继进入"切换中"：新进来的浏览器连接先暂存（最多 10 s），不转发、不直连
 3. 改身份 通过内核运行时接口把时区、WebRTC 地址改成新出口的（§5.4）
           内核不支持或调用失败 → 把已改的那一项改回旧值，放行暂存连接走旧上游，中止
           （改回也失败 → 中继停止转发，界面报错，等用户处理；不放行任何流量）
 4. 换上游 中继把上游指针换成新的，代数 +1；destroy 所有旧代数的 socket（两端都断）
           包括 keep-alive 连接池、HTTP/2 会话、WebSocket、还没收到上游回应的 CONNECT
 5. 放行   暂存的连接按新上游转发
 6. 刷新   重新加载所有顶层标签页；停止所有 Service Worker / Shared Worker
           （它们带着旧时区，也可能还在重试旧连接）
 7. 落盘   环境的 proxy / proxyNode、timezone 写成新值（手填时区保留）；
           LaunchInfo.persona 和 personaDigest 一并更新，relayPort 不变；
           记一条切换历史（时间、旧节点、新节点、发起方：界面 / MCP 连接名）
 8. 复核   中继经新上游再查一次出口，必须等于步骤 1 的 IP，且不等于本机直连 IP；
           不一致 → 中继停止转发（关闭式失败），界面报错
           之后补采一次指纹（现有 captureFingerprint），确认只有 timezone / webrtc 变了
 9. 收尾   旧内核进程退出
```

几点说明：

- **旧长连接全部断开**是步骤 4 的核心。中继现在已经在跟踪所有 socket（`sockets` 集合），只需要给每个 socket 记上"代数"，切换时断掉旧代数的全部连接。这样不会出现同一个页面一半请求走旧出口、一半走新出口的情况。
- **DNS 本来就走代理**：浏览器使用 HTTP 代理时不在本机解析目标域名；中继给上游的也是域名；sing-box 配置不开 sniff、不做本地解析。只要中继不新增任何本地 `dns.lookup(目标)`，这点就不会变（测试里有断言，§8.2）。
- **QUIC / UDP**：浏览器走 HTTP 代理时不使用 QUIC；WebRTC 策略是 `disable_non_proxied_udp`。切换过程中两者都不变，不会冒出 UDP 直连。
- **刷新的代价**：未提交的表单、页面内存里的状态会丢失，这是用户选择的方案。MCP 可以传 `reload: false` 自己掌握刷新时机，但返回值会提示"页面仍带旧时区，直到刷新"。
- 换出口对账号网站来说本身就是"IP 突变"，这属于账号风控风险，不是隔离问题。所以 MCP 默认要用户确认（§6.2）。

### 5.4 各内核的运行时接口

| 内核 | 时区 | WebRTC 地址 | 方案 |
| --- | --- | --- | --- |
| Vela Chromium 155（自编） | 需新增 | 需新增 | 在浏览器进程里加一个只对 Vela 管理器开放的命令（例如自定义 CDP 域 `Vela.setNetworkPersona {timezone, webrtcIp}`）。它更新浏览器进程里保存的值并推送给所有渲染进程（ICU 默认时区重置，等同启动时 `--fingerprint-timezone` 的效果）；之后新开的渲染进程直接读新值。**不用** `Emulation.setTimezoneOverride`：它只作用于已附加的目标，新开的 worker 或 iframe 可能在附加前就用旧时区跑了几行代码 |
| Vela Firefox（自编） | 需新增 | 需新增 | 现有的 owner RPC 增加一个命令：更新 `config.timezone` 和 WebRTC 地址，调用引擎内部的时区重置（`JS::ResetTimeZone` 一类），对所有内容进程生效 |
| CloakBrowser（第三方） | 不能改 | 不能改 | 自动重开：保存会话 → 关闭 → 用新代理启动 → 恢复标签页。用户不用操作，窗口会重建一次 |
| WebKit | 不能改（Playwright 上下文创建时就固定了 `timezoneId`） | 无 WebRTC | 同上，自动重开 |

内核接口那部分需要改 Vela Chromium 155 和 Vela Firefox 的源码，不在本仓库（`kernels/chromium` 下只有补丁），要和内核构建一起排期。在那之前，阶段 3 可以先让所有内核都走"自动重开"，热换等内核接口就绪后再打开。

### 5.5 管理器重启时正好在切换

切换在步骤 7 落盘之前，以 `LaunchInfo.persona` 为准，也就是旧出口；落盘之后以新出口为准。管理器重启后，`ensureSurvivorRelay` 按 persona 重起内核、重绑中继。步骤 3 已经改了浏览器内的身份但还没落盘时，重启后浏览器里是新时区、中继是旧出口。为此 `ensureSurvivorRelay` 要把 persona 里的时区和 WebRTC 地址重新推给浏览器一次（幂等），保证两者一致后再放行流量。

---

## 6. MCP

### 6.1 新工具（命名沿用 `vela_<对象>_<动作>`）

```jsonc
// 只读：列出池内节点，不返回任何密码、uuid、订阅链接
{ "name": "vela_proxy_pool_list",
  "annotations": { "readOnlyHint": true },
  "inputSchema": { "type": "object", "additionalProperties": false, "properties": {
    "country": { "type": "string", "description": "ISO 3166-1 alpha-2，按实际出口筛选" },
    "tag":     { "type": "string" },
    "status":  { "type": "string", "enum": ["working", "unstable", "failed", "unavailable", "unchecked"] },
    "available": { "type": "boolean", "description": "只列还没到共享上限的节点" } } } }
// 返回 [{ nodeId, name, protocol, country, city, timezone, status, latencyMs, rotating,
//        insecureTls, assignedProfiles: n, maxProfiles }]

// 检测节点（会产生到出口查询服务的流量）
{ "name": "vela_proxy_pool_check",
  "annotations": { "readOnlyHint": false, "openWorldHint": true },
  "inputSchema": { "type": "object", "additionalProperties": false,
    "properties": { "nodeIds": { "type": "array", "items": { "type": "string" }, "maxItems": 50 } },
    "required": ["nodeIds"] } }

// 给环境换代理：关闭的环境 = 下次启动生效；运行中 = 热切换（或自动重开）
{ "name": "vela_browser_set_proxy",
  "annotations": { "destructiveHint": true, "openWorldHint": true },
  "inputSchema": { "type": "object", "additionalProperties": false,
    "properties": {
      "profileId": { "type": "string", "minLength": 1 },
      "nodeId":    { "type": "string" },
      "reload":    { "type": "boolean", "default": true } },
    "required": ["profileId", "nodeId"] } }
// 返回 { profileId, applied: "next_launch" | "hot_switched" | "reopened",
//        exit: { ip, country, timezone }, previousNodeId, pagesReloaded }
// 错误码：approval_denied / approval_timeout / node_unavailable / node_over_limit /
//        switch_check_failed / profile_busy / rate_limited
```

- `vela_browser_set_proxy` **只接受池内节点 id**，不接受 AI 直接给的原始代理或订阅链接。导入订阅和添加节点只能在界面里做，避免 AI 被网页内容诱导，把环境接到攻击者的代理上。现有的 `vela_profile_create` 仍可带原始 `proxy`，保持不变。
- 对应的 runtime 方法：`proxyPool.list`、`proxyPool.check`、`profiles.setProxy`，放进 `src/agent-control.ts` 的 switch。
- `vela_profiles_list` / `vela_browser_status` 的结果里加上 `proxyNodeId` 和出口国家，方便 AI 判断，同样不带凭据。

### 6.2 审批

现有的 MCP 工具都不需要审批（`docs/mcp-devtools.md`）。换出口不一样，它会让账号网站看到 IP 突变，而且是对外的、不能撤回的。

- **默认：每次询问。** Vela 界面弹一张卡片："<MCP 连接名> 要把 <环境名> 从 <美国·洛杉矶 / 节点A> 换到 <日本·东京 / 节点B>"，带"允许 / 拒绝"。60 s 无响应视为拒绝，返回 `approval_timeout`。
- 按 MCP 连接设置（挂在现有 `mcp.connectors` 记录上）：`ask`（默认）/ `allow_pool`（池内节点直接放行）/ `deny`。
- 频率限制：同一环境两次切换间隔至少 30 s，防止 AI 来回切。
- 关闭环境的"下次启动生效"不走审批，但同样记历史。

---

## 7. 隔离底线（不变量清单，每一条都要有测试）

1. **中继没有直连模式。** `UpstreamProxy` 必须非空；切换到"无代理"的请求直接拒绝（走自动重开）。中继里不存在 `net.connect(目标)` 这样的代码路径，代码审查时 grep 确认。
2. **切换期间只有三种状态**：旧上游转发 / 暂存 / 新上游转发。任何异常都落到"停止转发"。
3. **旧代数的 socket 在新上游放行之前全部销毁**，以 socket 关闭事件为准，而不是"调用了 destroy"。
4. **内核配置里没有 direct 出站，`final` 是 block**，没有 tun / 系统代理 / 自动路由。生成后断言，启动内核前再断言一次。
5. **内核或中继崩溃 = 断网，不是直连。** 浏览器的 `--proxy-server` 始终指向 127.0.0.1 的中继端口，Chromium 连不上代理时不会回退直连。
6. **有代理的环境，WebRTC 策略始终是 `disable_non_proxied_udp`**，运行中不改。
7. **出口复核**：切换后，以及管理器重启后恢复中继时，经中继看到的出口必须不等于本机直连 IP。
8. **全局零改动**：系统代理设置、路由表、网卡列表、hosts、系统 DNS 设置，在 Vela 运行前后完全一致。
9. **浏览器在本机不解析任何名字**（阶段 0 实现）。
   - Chromium（Vela Chromium 155、CloakBrowser）：有代理时加 `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1 , EXCLUDE [::1]`。代理本身是回环 IP，不需要解析；预取、预连接、内置异步 DNS、DoH 初始化发起的解析，统统落到 `~notfound`。
   - Firefox：远程 DNS，关掉 DNS 预取和预测器，TRR（DoH）设为 5（关闭）。另外关掉原生 HTTPS 记录查询（`network.dns.native_https_query*`、`upgrade_with_https_rr`、`use_https_rr_as_altsvc`、`force_use_https_rr`），以及 `prefetch_via_proxy`。
   - 中继和 SOCKS 客户端：代码里不出现任何解析调用；每个套接字只连上游代理。由静态检查测试 `src/proxy-dns-guard.test.ts` 守住。
10. **没有任何"代理失败就直连"的退路**（阶段 0 实现）。Firefox 关掉 `network.proxy.allow_bypass`（代理失败时，更新和媒体插件下载会直连重试）和 `network.proxy.failover_direct`。Chromium 固定代理本来就没有直连回退。启动器在"有代理却没有中继端口"时直接报错，不会把上游直接交给浏览器。
11. **不往局域网组播**（阶段 0 实现）。有代理的 Chromium 关掉 `MediaRouter`：投屏发现会从本机每块网卡组播 mDNS 查询。实测关闭后，页面能看到的投屏相关 API 不变。

### 7.1 阶段 0 实测发现的线上版本问题（0.1.7）

阶段 0 的真实浏览器检测在当前线上版本里查出两处 Vela Firefox 泄露，都已在阶段 0 修掉：

- **DNS**：有代理时，Firefox 仍然通过系统 `getaddrinfo` 查每个访问网站的 HTTPS 记录（DNS 类型 65）。也就是说，本机 DNS 服务器能看到环境访问的每一个域名。
- **Kill Switch**：代理拒绝或失败时，Firefox 的应用更新检查（aus5.mozilla.org）和媒体插件下载（OpenH264、Widevine）会绕过代理，用本机地址直连重试。

代价：没有 HTTPS 记录以后，Firefox 对开了 ECH 的网站只发 GREASE ECH，不发真实 ECH。要拿回真实 ECH，需要让 DoH 经中继走并另行验证，列为跟进项。

---

## 8. 验收（含真实内核下的泄露检测）

### 8.1 本机泄露测试台（CI 里跑，不依赖外网）

用真实的 sing-box 同时扮演"节点服务端"和"客户端内核"：

- 起两个本机服务端：节点 A（如 vless+reality）出站绑定 `127.0.0.3`，节点 B（如 hysteria2）出站绑定 `127.0.0.4`。
- 起一个"金丝雀"站点，监听 `127.0.0.2`，记下每个连接的来源地址：`127.0.0.3` 代表走了 A，`127.0.0.4` 代表走了 B，**其他任何来源都是泄露**。
- 浏览器（Vela Chromium 155 / Vela Firefox / CloakBrowser / WebKit 各跑一遍）通过 环境中继 → 客户端内核 → 节点服务端 → 金丝雀 访问。
- 金丝雀域名（例如 `canary.vela.test`）只在节点服务端的 DNS 里有记录。本机解析不到；本机若尝试解析，会被本机 DNS 探针记录下来，即为 DNS 泄露。

**阶段 0 已经实现的部分**（`src/leak-live.test.ts`，设置 `VELA_LEAK_LIVE=1` 时运行，在真实的 Vela Chromium 155 和 Vela Firefox 上跑）。这里的"出口"是一个本机假出口：它为 `*.vela-leak.test`、203.0.113.7、`[2001:db8::7]` 提供页面并记下所有请求，自己从不连外网。下面这些观察者彼此独立，并且都不依赖"出口 IP 对不对"，所以开着系统级 TUN 也照样有效：

- **浏览器自己的日志**：Chromium 的 net-log 记录每次解析任务、DNS 事务、TCP / UDP 连接和 UDP 发送；Firefox 的 MOZ_LOG 记录解析器和套接字传输。
- **操作系统连接表**：用 `netstat` 每秒采样，只看检测启动的浏览器进程树，用户自己开着的窗口不算。
- **Windows DNS 缓存**：查本次检测专用的名字有没有出现在里面。
- **局域网金丝雀**：在本机真实局域网 IPv4 / IPv6 地址上开 TCP 和 UDP 监听，页面对这些地址发请求，也把它们配成 STUN / TURN 服务器。只要有一个包没经过中继，金丝雀就会收到。
- **mDNS 旁听**：加入 224.0.0.251 和 ff02::fb 组播组，记录本机发出的 mDNS 包。
- **Kill Switch**：页面持续发请求，中途关掉中继，之后不允许任何请求再到达任何地方。
- **观察时长**：每轮至少 60 秒（`VELA_LEAK_OBSERVE_MS` 可调），后台任务（更新检查、投屏发现）都会落在窗口里。
- **管理员抓包**：`scripts/leak-check/pktmon-dns.ps1` 需要管理员权限，带阳性对照。
- **全局快照**：`scripts/leak-check/global-snapshot.ps1` 对比运行前后的系统代理、WinHTTP、路由、网卡、DNS 服务器和 hosts。

### 8.2 用例

| 用例 | 通过条件 |
| --- | --- |
| 订阅解析：各协议样本（含 anytls）、坏样本、信息条目、未知字段 | 结果与快照一致；未知字段的节点标"不支持"，不会被导入成残缺节点 |
| 非出口类型：`proxies` 里混入 `direct` / `reject` / `dns`，sing-box JSON 里混入 `direct` / `block` | 全部计为"非节点"，池里查不到，任何分配接口都选不到 |
| 信息条目：节点名含"剩余流量""到期"等关键词，或服务器是回环地址 | 归入信息条目，不可分配 |
| `subscription-userinfo` 头：正常、缺字段、格式错误、缺失 | 正常时显示剩余流量和到期日；其他情况不显示也不报错 |
| UA 回退：clash.meta 返回非 YAML | 自动用 v2rayN 再拉一次，并解析出 base64 URI |
| 内核配置生成 | 断言没有 direct、`final=block`、没有 tun / sniff、入站只听 127.0.0.1 且有认证 |
| 内核哈希不符 | 拒绝启动该环境，其他环境不受影响 |
| 走 A 浏览、走 B 浏览 | 金丝雀只看到 `127.0.0.3` / `127.0.0.4` |
| **切换压力**：页面持续发 fetch 轮询、WebSocket、大文件下载、长轮询，期间 A↔B 来回切换 100 次 | 金丝雀上**从未出现**第三种来源；任一切换时刻 T 之后，不再有新请求经由旧来源完成；每次切换后旧 WebSocket 断开 |
| 切换中途内核卡死 / 被杀 | 请求失败，没有直连；看门狗拉起后恢复 |
| 新节点不可用 | 切换中止，仍走旧出口，没有出现"暂存期间超时后放行到直连"之类的情况 |
| 时区与 WebRTC | 切换并刷新后，在顶层页面、跨域 iframe、Dedicated / Shared / Service Worker 里检查 `Intl…timeZone`、`getTimezoneOffset()` 都是新出口的时区；本机 STUN 测试页拿到的公网候选是新出口 IP，没有本机网卡地址 |
| 指纹复核 | 切换前后 `captureFingerprint` 对比，差异只有 timezone / webrtc |
| 本机 DNS | 整个测试期间本机 DNS 探针没有记录到 `canary.vela.test` 和任何浏览目标域名 |
| 管理器在步骤 3–7 之间重启 | 恢复后浏览器里的身份与中继出口一致才放行（§5.5） |
| 直连环境请求换代理 | 走自动重开，不热换；重开后 WebRTC 策略为 `disable_non_proxied_udp` |
| MCP | 默认弹审批；拒绝 / 超时返回对应错误码且什么都没改；`allow_pool` 下直接生效；返回值里不含任何凭据 |

### 8.3 真实网络（发版前手工 + 脚本）

- **用用户提供的三份真实订阅**做真实网络验收。它们覆盖了 vless（reality、ws、xtls-rprx-vision）、hysteria2、anytls，以及 `skip-cert-verify` / `insecure=1`、`type: reject` 条目、大量 `select` / `url-test` / `fallback` 分组和 `subscription-userinfo` 头。验收时要核对导入报告：每份订阅的节点、非节点、信息条目、不支持条目的数量与实际一致，`reject` 没有被导入成节点，anytls 节点能连通。
- **订阅链接是用户的凭据**：不写进仓库、文档、提交说明、日志、测试快照或 CI 配置。需要时现场向用户要，或从本机仓库外的安全位置读取（例如用户自己放的环境变量或文件），用完不落盘。离线的解析测试用自己编的样本，不用真实订阅的内容（节点名、服务器地址、凭据都不能出现在快照里）。
- 每个节点类型选几个，在 Windows / macOS / Linux 各跑一遍：出口查询服务看到的 IP 等于节点出口且不等于本机直连 IP；在公开的 WebRTC / DNS 泄露检测页面上不出现本机 IP 和本机 DNS 服务器。
- 抓包（Windows 用 `pktmon`，macOS / Linux 用 `tcpdump`）：浏览期间本机所有出网流量只发往节点服务器地址，以及 Vela 自身的更新和出口查询服务。浏览目标网站的地址一个都不能出现。

### 8.4 "只影响对应环境，不碰全局"

测试前后各快照一次并对比，要求完全一致：

- Windows：`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 下的 `ProxyEnable` / `ProxyServer` / `AutoConfigURL`、`netsh winhttp show proxy`、`route print`、`Get-NetAdapter`（不能多出 TUN 网卡）、hosts 文件。
- macOS：`scutil --proxy`、`netstat -rn`、`ifconfig`（不能多出 utun）。
- Linux：环境变量、`ip route`、`ip link`。
- 同一时刻用 `curl` 从系统直接访问出口查询服务，看到的是本机直连 IP，说明其他软件没有被代理。

---

## 9. 分阶段实现

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **0 · 中继统一 + 防泄露** | 有代理的环境（所有内核、所有代理类型）一律走中继，`needsProxyRelay` 简化为 `!!profile.proxy`；中继支持"代数 + 暂存 + 换上游 + 断开旧代数"（先不对外开放）；§7 第 9–11 条（浏览器在本机不解析名字、没有直连退路、不往局域网组播） | 现有测试全绿；中继热换单测、静态检查测试；§8.1 阶段 0 检测台在 Vela Chromium 155 和 Vela Firefox 上通过；Chromium 指纹开关前后一致；§8.4 全局快照不变 |
| **1 · 代理池（不含内核）** | `ProxyNode` / `ProxySubscription` 表；池子页面；粘贴或导入 http / https / socks5；健康检测；分组、标签、共享上限；环境编辑和批量换代理可以从池里选 | 解析、分配、上限、粘性分配单测；从池里选的节点启动，出口与检测结果一致 |
| **2 · 订阅 + sing-box** | 订阅拉取和解析（§2）；sing-box 下载、哈希、每环境一个进程、看门狗；检测专用共享内核；启动时经内核查出口 | §8.1 测试台搭好；§8.2 中解析、配置生成、哈希、A/B 浏览、内核崩溃、本机 DNS 各项通过；§8.3 真实订阅三平台通过 |
| **3 · 运行中换代理（界面）** | 环境卡片和详情里的"换代理"；先对所有内核走"自动重开"，然后 Vela Chromium 155 / Vela Firefox 内核接口就绪后打开热换并刷新；切换历史 | §8.2 切换压力、时区与 WebRTC、指纹复核、管理器重启各项通过（每个内核都要过） |
| **4 · MCP** | 三个工具、审批卡片、按连接的权限设置、频率限制；`docs/mcp-devtools.md` 和公开文档同步 | MCP 用例通过；`docs:public:check` 通过 |

每个阶段单独开 PR，先合到 beta 分支给测试用户，不直接合 main（合 main 就等于发给所有人）。

---

## 10. 需要用户拍板的点

1. 内核选 sing-box（最低 1.12.0，为了支持 AnyTLS），每个用订阅节点的环境一个进程，是否同意。
2. 共享默认值分两档：机场订阅节点默认可共享，但提示与哪些环境共用出口；手动添加的节点（静态住宅等）默认独占。是否同意，或者两档都改成同一种。
3. MCP 换代理默认每次询问，可以按连接改成池内节点直接放行，是否同意。
4. CloakBrowser / WebKit，以及"直连 ↔ 代理"之间的切换，走自动重开而不是热换。这是内核能力和 WebRTC 隔离决定的，不是地区限制。
5. Vela Chromium 155 / Vela Firefox 的运行时身份接口需要改内核源码，要与内核构建排期。在那之前，热换会先以"自动重开"的形式上线。

## 11. 另列的跟进项（不在本设计范围）

- 中继端口目前没有认证，同机其他进程可以连接。可以考虑每次启动生成随机凭据，由浏览器带上（Chromium 不接受 `--proxy-server` 内嵌凭据，需要内核补丁或其他办法）。
