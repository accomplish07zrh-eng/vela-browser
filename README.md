<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img src="docs/assets/banner-light.svg" alt="Vela Browser：本地优先的指纹浏览器。一面墙上，许多浏览器同时运行，各有各的指针。" width="100%">
  </picture>
</p>

<p align="center">
  <b>中文</b>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/accomplish07zrh-eng/vela-browser/releases">启航</a>
  &nbsp;·&nbsp;
  <a href="#wall">一面墙</a>
  &nbsp;·&nbsp;
  <a href="#identities">来路</a>
  &nbsp;·&nbsp;
  <a href="#proxies">门户</a>
  &nbsp;·&nbsp;
  <a href="#cooling">熄灯</a>
  &nbsp;·&nbsp;
  <a href="#agents">几双手</a>
  &nbsp;·&nbsp;
  <a href="#plugins">工具</a>
  &nbsp;·&nbsp;
  <a href="#build">造船</a>
</p>

<br>

<p align="center"><i>
一扇窗，一盏灯。<br>
灯下的人互不相识，<br>
门户也朝向各自的风。
</i></p>

<p align="center"><sub>VELA　拉丁文里的「帆」，南天的船帆座</sub></p>

<br>

## 序

<p align="center">
你的桌上有许多扇窗。<br>
每一扇后面，都住着一个完整的人：<br>
指纹是一圈一圈长成的年轮，<br>
来路是只认门牌的潮汐，<br>
Cookie 是抽屉里一封写到一半的信。
</p>

<p align="center">
他们从不串门，也不借邻家的路出门。<br>
隔着一堵墙，各自点灯，各自熄灯。
</p>

<p align="center">· · ·</p>

<p align="center">
而这面墙，就立在你的手边。<br>
没有账号，没有云端，<br>
没有谁在远方，替你捏着备用的钥匙。
</p>

<br>

<a name="wall"></a>

## 壹　一面墙

<p align="center"><sub>THE WALL</sub></p>

<p align="center"><i>
一个分组是一行，一行是一条河。<br>
相邻的河逆向而流，<br>
灯火在两岸，隔水相望。
</i></p>

慢一点，再慢一点，\
像深夜的车窗外，两列擦肩的慢车，\
一格一格，把别人的灯火平稳地拉过去。

退在后排的窗也不曾定格成画——\
灯芯还燃着，页面里正走着的风吹草动，墙上照样看得真切。

　　然后你双击了其中一扇。

它朝你迎上来，\
整面墙收束成一只寻常方框：\
能点，能写，能一页一页往下翻，\
和独门独户的窗口别无二致。

你在这扇窗里落笔，\
追随它的几扇也同时动笔：\
一人领唱，众人相和，涟漪在同一刹那泛开。\
案头铺着纸白，入夜换成墨色，\
菜单与确认框都用同一套纸笔裁成，\
用完了按一下 <kbd>Esc</kbd>，所有抽屉一齐退回墙后。

<details>
<summary><b>灯下细看</b></summary>
<br>

- **工作台与实时画面**：所有打开的浏览器铺成一面墙；退在后台的窗口依然保持运行并持续刷新实况画面，双击任意一块即可放大并直接点击、输入、滚动。
- **分组河流**：一个分组占一行，行可首尾相连成循环带，相邻两行反向漂移；可单独看某一行，或调整行高把重点留在眼前。
- **同步**：指定一个环境为主控，其余跟随它的点击与键入；横幅第一行齐齐泛开的涟漪即为此。
- **安静桌面**：Windows 上可将环境窗口从任务栏隐藏；只收起任务栏按钮，窗口本身和网页读取到的一切均不变。
- **纸白外壳与浮动坞**：Windows 与 Linux 采用与主题一致的自绘标题栏；导航收于底部悬浮坞，其余页面从下方升起，设置与扩展在宽屏下呈左右两栏，按 <kbd>Esc</kbd> 回到墙上。

</details>

<br>

<a name="identities"></a>

## 贰　千种来路

<p align="center"><sub>IDENTITIES</sub></p>

<p align="center"><i>
同一张书桌，千种籍贯。
</i></p>

有人从东京的雨里来，有人从柏林的雪里来，\
有人只说英文，有人一开口便是吴侬软语。

屏幕有多宽，抽屉里备了几套字帖，\
声卡里藏着哪一副嗓音，\
显卡上落着什么成色的灰，\
都从第一次推门写进他的户籍——\
不换门庭时，到最后一次合眼不改一笔。

门掩上了，信纸原样压在镇纸底下；\
下回推门，墨迹还没干透。

<details>
<summary><b>灯下细看</b></summary>
<br>

- **三类内核**：Vela Chromium 155、CloakBrowser、Vela Firefox 按环境自选；WebKit 处于实验阶段。不同系统缺失的对应字体包按需自动补齐。
- **全套指纹**：屏幕、字体、语音、媒体设备、WebGL、WebRTC、语言与时区按环境生成并持久固定（切换代理出口时，未手动指定时区者与 WebRTC 公网地址随新出口同步重定）。
- **会话留存**：关闭时保存 Cookie（含 Firefox 会话 Cookie）与站点存储，下次打开按原样恢复。
- **批量整理**：分组管理、便携导入导出、回收站与定时任务。

</details>

<br>

<a name="proxies"></a>

## 叁　各走各的门

<p align="center"><sub>EACH BY ITS OWN DOOR</sub></p>

<p align="center"><i>
院墙外头车马喧哗，<br>
院里每一扇窗，只推开自己脚下的石阶。
</i></p>

这台电脑自己走什么路，照旧走什么路：\
没有虚拟网卡横在总门前，不改系统代理，也不动一张路由表。\
每一扇借道出门的窗，都在门后立着自己的本地中继；\
若是挂着协议订阅的节点，便再替它单生一座小炉灶——\
一屋一灶，谁的烟火也不串进隔壁的烟囱。

订阅链接收进门来，要先过几道筛子：\
直连与拒止的空签留在门槛外，\
印着余量与期日的广告单另搁在旁边的木盘里，\
但凡夹着半句认不出的暗语，宁可整条弃置，也不拆掉护栏凑合过桥。\
借来的通票允许同舟，名册上却把共渡同一处渡口的几扇窗一一画圈；\
自家手栽的独院门，默认只进一人，不教两道影子踩进同一处脚印。

整串门牌与密匙，都锁在只认这台机器、这位主人的铁匣里。\
窗内从来不向本地街坊打听路名，也不向局域网里喊一声传呼；\
若半途绳断灶熄，渡船宁可停在岸边闭门谢客，绝不改走自家的旱路。

　　半途想换一道门庭也不必慌：

先差人去新渡口外探准风色，\
再把未寄完的信封进抽屉，掩门，按原样重开——\
推窗那一瞬，壁上的挂钟与河岸的水声，已经换成了新地方的时辰；\
再隔着自己的门缝往外看一眼，确认外头认出的并非本机门牌，才算落定。

<details>
<summary><b>灯下细看</b></summary>
<br>

- **代理池与订阅导入**：在「代理 → 代理池」一次导入即可分配给多个环境。支持逐行粘贴 `http` / `https` / `socks5`（`host:port:user:pass` 或 URL），也支持导入 HTTPS 订阅链接（自动识别 Clash / mihomo YAML、sing-box JSON、整段 Base64 或明文 URI；按 `clash.meta` 优先、失败回退 `v2rayN` 拉取；解析 `subscription-userinfo` 展示已用/剩余流量与到期提醒）。
- **协议覆盖与严格筛查**：支持 `http`、`https`、`socks5`、`Shadowsocks`、`VMess`、`VLESS`（含 Vision、REALITY、ECH）、`Trojan`、`Hysteria2`、`TUIC` 与 `AnyTLS`。`direct`、`reject`、`block`、`dns` 等非出口条目与「剩余流量 / 到期」类信息条目永不当作可用节点；出现未知字段时整条标为不支持，绝不删掉 TLS 或传输参数勉强导入。
- **共享规则与粘性分配**：订阅节点默认可共享，并在列表与环境上标出共用同一实际出口 IP 的环境；手动添加的节点（如静态住宅、独享 IP）默认独占（上限 1 个环境），避免账号关联。节点失效或从订阅移除时保持原快照并提示，不自动替账号换到陌生 IP。
- **零全局改动与独立协议内核**：不设 TUN 网卡、不改系统代理、不改路由表与 hosts。所有带代理的环境一律经过各自的 `127.0.0.1` 中继；需协议内核的节点按环境各自运行一个独立的 `sing-box` 进程（首次用到时从官方发布下载并校验写死的 SHA-256，守护拉起并清理崩溃残留，配置中无 `direct` 出站且 `final` 为 `block`，仅节点服务器域名经专用 DoH 解析）。
- **防泄露与断网保护（Kill Switch）**：Chromium 开启 `--host-resolver-rules`（`MAP * ~NOTFOUND`）并关闭 `MediaRouter`（禁绝局域网 mDNS 组播）；Firefox 强制远程 DNS、关闭预取、TRR 与原生 HTTPS 记录查询，同时关闭 `allow_bypass` 与 `failover_direct`。中继或协议内核中断即关闭式断网，绝不回退本机直连。
- **静态加密与导出保护**：订阅链接、节点地址与凭据均经 AES-256-GCM 加密落盘，每份数据目录独立生成 `proxy-pool.key` 并由 Windows DPAPI 绑定当前账户（macOS / Linux 仅限本用户可读）；携订阅节点导出时自动锁定代理直至在目标机器重新指派，不会以直连方式打开。
- **运行中换出口**：可在编辑环境或通过 MCP 更换出口。先预检新出口可用性（失败则原地不动）；运行中的环境先保存会话与标签页，确认关闭后再以原有窗口或无头模式重开并恢复标签页，时区与 WebRTC 公网地址随新出口重定，随后经自身中继复核出口（若测得本机直连 IP 则立即关闭）。单环境每 30 秒限切一次，互斥加锁并留存切换记录。

</details>

<br>

<a name="cooling"></a>

## 肆　熄灯，不散场

<p align="center"><sub>COOLING</sub></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cooling-dark.svg">
    <img src="docs/assets/cooling-light.svg" alt="内存占用升过阈值线，最久无人照看的那个浏览器冷却熄灯，内存回落；之后被双击唤醒。" width="100%">
  </picture>
</p>

<p align="center"><i>
夜深了。<br>
最久没人照看的那扇窗，先熄了灯。
</i></p>

不是告别。

信折好了，放进抽屉；\
钥匙压在门口的花盆底下。\
屋子还挂在墙上，只是暗着，\
窗玻璃上结了一朵小小的霜花。

　　内存的水位落下去，\
　　　　整台电脑轻轻舒了一口气。

你回来时只消点它一下——\
茶还温着，书还翻在那一页。

<details>
<summary><b>灯下细看</b></summary>
<br>

- **何时熄灯**：物理内存占用越过阈值时，挑出闲置最久的浏览器，沿「关闭」路径先保存会话再释放进程（macOS 将可丢弃的文件缓存计入可用内存）。
- **仍在墙上**：环境格子不会从工作台消失，只退暗并标明「已冷却」；双击或点「唤醒」，登录态与标签页原样归来。
- **不碰忙人**：你正在浏览的、脚本或 AI 正在操作的、刚刚动过的窗口不会被冷却。
- **由你定界**：默认内存占用达 85%、闲置满 10 分钟时触发；两项均可在设置中调整（60%–95%、1–240 分钟），也可完全关闭。

</details>

<br>

<a name="agents"></a>

## 伍　一个念头，几双手

<p align="center"><sub>ONE THOUGHT, MANY HANDS</sub></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/agents-dark.svg">
    <img src="docs/assets/agents-light.svg" alt="一个 AI 同时连着三个浏览器窗口，每个窗口有自己的指针，各按各的节奏点击和输入。" width="100%">
  </picture>
</p>

<p align="center"><i>
一个念头，分作几双手。<br>
各用各的墨色落笔，<br>
谁也不碰谁的砚台。
</i></p>

窗外的雨下得正密。\
墙上三四扇窗同时忙碌起来：Claude Code 执橘色，Codex 执蓝，Hermes 是紫，Cursor 是绿……\
每一家有自己的彩色小箭与名签，轻轻巧巧停在玻璃外头的画框上，让你一眼看清谁在替哪一屋跑腿；\
而窗里头，网页对那支笔的来影毫无知觉，你桌上的那只真鼠标也纹丝不动。

指针走路的模样，像人：

起步时略有一点迟疑，\
半途快起来，\
长路偶尔走过几寸，再折回落定；\
敲字也像人——一个键，一个键，逢着句读停一停，想一想。\
若有一串熟门熟路的动作，也能并作一气呵成。

F12 底下那条暗河，它也看得见：\
控制台里的低语，网络上往来的原信，WebSocket 里不停歇的电报。\
只是每扇门前它都先轻叩一声；\
尤其要替一屋人换门庭、改出口时，它决不擅自开锁——\
先隔着代理池看一眼天气，再把一张字条递到你眼前，等你点头，门才开。

<details>
<summary><b>灯下细看</b></summary>
<br>

- **MCP 与多 AI 指针**：内置 `Vela Browser` MCP 服务（`vela-browser-mcp`），兼容 Claude Code、Codex、Cursor、Hermes、OpenClaw、Gemini 等客户端；多个 AI 可同时驱动不同窗口而不互抢，工作台卡片按 AI 名称以固定颜色绘制各自指针（仅存于 Vela 视图层，网页不可见）。
- **拟人输入与批量动作**：指针按缓动曲线移动，长距偶有过冲修正，落点散在控件内部并用滚轮翻页；键入带韵律与标点停顿，各环境习惯持久不同（`vela_humanize` 可调速或关闭）。`browser_batch` 可在单次调用内连续执行多步页面动作并跳过冗余快照。
- **开发者工具**：`browser_devtools_*` 覆盖控制台与异常堆栈、网络请求与原始响应字节、WebSocket 帧、DOM 与计算样式、存储与 Cookie（默认仅返回当前页会附带的 Cookie，整套环境需显式请求）、经由环境自身网络发出的 `fetch` 以及 Chromium 原生 CDP；详见证 [`docs/mcp-devtools.md`](docs/mcp-devtools.md)。
- **AI 查池与换代理审批**：提供 `vela_proxy_pool_list`、`vela_proxy_pool_check` 与 `vela_browser_set_proxy`，只接受池内 `nodeId`、永不接受 AI 传入的原始代理或订阅链接，也不返回任何密码、UUID 或订阅 URL。因换出口会改变网站看到的 IP，默认每次弹出最外层审批卡（60 秒未答自动拒绝），可在「代理 → 代理池 → AI 换代理」中设为每次询问、池内节点直接放行或一律拒绝。
- **脚本台与本地接口**：内置脚本页支持 JavaScript（`.js` / `.mjs`）与 Python（`.py`）Playwright 脚本及公共脚本库，可单环境顺序或批量并发执行，JS 脚本可通过 `devtools.call(...)` 调取运行期控制台与网络记录；另提供兼容 AdsPower `/api/v1` 风格的本地 HTTP 接口。

</details>

<br>

<a name="plugins"></a>

## 陆　趁手的工具

<p align="center"><sub>TOOLS THAT FIT THE HAND</sub></p>

<p align="center"><i>
给远行的人，塞一把小刀，<br>
一卷绳子，一盏马灯。
</i></p>

在 `plugins` 里摆一只木匣，\
一张清单，几行手艺，\
AI 便多了一件顺手的活计：

```js
// plugins/page-info/index.mjs
export default function setup(vela) {
  return {
    async summary() {
      const page = vela.page();
      const errors = await vela.devtools("console", { level: "error" });
      return { title: await page.title(), errors: errors.records.length };
    },
  };
}
```

它只在此刻站着的那扇窗里使：\
用这间屋子的钥匙，走这间屋子的路，\
带不走门闩，也翻不进隔壁的院墙。\
Chromium、Firefox、WebKit——\
三种灯火，同一把小刀。

<details>
<summary><b>灯下细看</b></summary>
<br>

- **目录约定**：放在数据目录 `plugins/<插件名>/` 下，含 `vela-plugin.json` 与 JS 模块，`setup(vela)` 返回工具函数（例如上例暴露为 `plugin_page_info_summary`）。
- **沙盒与范围**：在 AI 选中的环境上下文内运行，沿用该环境的会话、代理与指纹；不能关闭浏览器，各环境之间的插件状态互不串通。
- **管理与开发**：在「设置 → 高级 → 插件」逐个启停或一键添加示例；编写规范见 [`docs/plugins.md`](docs/plugins.md)。插件代码直接运行在你的电脑上，只安装你信任的来源。

</details>

<br>

<a name="install"></a>

## 柒　启航

<p align="center"><sub>INSTALL</sub></p>

<p align="center"><i>
帆已经挂好了。<br>
风从哪边来，都行。
</i></p>

Windows：在 [Releases](https://github.com/accomplish07zrh-eng/vela-browser/releases) 下载安装包。

macOS：

```bash
curl -fsSL https://raw.githubusercontent.com/accomplish07zrh-eng/vela-browser/main/scripts/install-macos.sh | bash
```

Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/accomplish07zrh-eng/vela-browser/main/scripts/install-linux.sh | bash
```

<p align="center"><sub>应用内更新携带独立签名，只认本仓库发出的版本。</sub></p>

<br>

<a name="build"></a>

## 捌　造船

<p align="center"><sub>BUILD FROM SOURCE</sub></p>

<p align="center"><i>
想亲手造一条船，<br>
先备好木料与钉子。
</i></p>

需要 [Bun](https://bun.sh) 1.4.1 或更高版本；打包桌面版另需 Rust 与 [Tauri](https://tauri.app) 构建依赖。

```bash
bun install
bun test
bun start
```

打包 Windows 桌面安装包：

```bash
bun run desktop:prepare
bun run desktop:build:nsis
```

<p align="center"><sub>这一页会动的插画，出自 <code>python scripts/make-readme-art.py</code>。<br>若你的系统开启了减少动态效果，它们便安安静静地停在纸面上。</sub></p>

<details>
<summary><b>船上的物件</b></summary>
<br>

| 位置 | 内容 |
| --- | --- |
| `src/` | 环境管理、启动器、指纹、本地中继、代理池、订阅解析、协议内核监管、切换与加密存储、冷却、插件与本地服务 |
| `web/` | 界面：工作台墙面、浮动坞、多色 AI 指针、代理池与审批浮卡、脚本台及各设置页 |
| `src-tauri/` | 桌面外壳、安装器与应用内签名更新 |
| `agent/` | MCP 服务、开发者工具、插件宿主机、拟人输入与脚本运行器 |
| `scripts/` | 打包、安装脚本、泄露检测台、验收与 README 插画脚本 |
| `docs/` | 插件、开发者工具、设计稿与公开的本地 API / MCP 工具清单 |
| 根目录 `*.mjs` | 浏览器后台进程；打包后需与 `agent/` 同层，故留在根目录 |

</details>

<br>

## 跋

<p align="center"><i>
这条船的龙骨，来自另一条船。
</i></p>

Vela Browser 是 [AliasMode](https://github.com/aliasmode/aliasmode) 的独立分支，与上游项目及其维护者没有隶属或背书关系。

- 应用代码沿用 Apache License 2.0，原始代码版权归 Xreacher 所有。
- AliasMode Firefox 内核采用 MPL-2.0，AliasMode Chromium 内核采用 GPL-3.0。
- CloakBrowser 为第三方内核，适用其自身的许可条款。
- 订阅协议所依赖的 `sing-box`（Copyright (C) 2022 nekohasekai，GPL-3.0-or-later）为独立开源程序；Vela Browser 不内置亦不修改其代码，首次使用订阅节点时自 [SagerNet/sing-box](https://github.com/SagerNet/sing-box) 官方发布下载并校验 SHA-256 后原样运行，双方无关联或背书关系。
- 字体、语音与媒体设备数据等第三方资源的完整版权与许可见 [`NOTICE`](NOTICE)。

<br>

<p align="center">· · ·</p>

<br>

<p align="center"><i>
Every window keeps its own lamp.<br>
<a href="README.en.md">The whole book, in English</a>
</i></p>
