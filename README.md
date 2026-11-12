<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img src="docs/assets/banner-light.svg" alt="Vela Browser：本地优先的指纹浏览器。一面墙上，许多浏览器同时运行，各有各的指针。" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/accomplish07zrh-eng/vela-browser/releases">下载</a>
  &nbsp;·&nbsp;
  <a href="#一面墙">工作台</a>
  &nbsp;·&nbsp;
  <a href="#熄灯不散场">冷却</a>
  &nbsp;·&nbsp;
  <a href="#交给-ai">AI 操控</a>
  &nbsp;·&nbsp;
  <a href="#插件">插件</a>
  &nbsp;·&nbsp;
  <a href="#从源码构建">从源码构建</a>
  &nbsp;·&nbsp;
  <a href="#in-english">English</a>
</p>

<br>

<p align="center"><i>
一扇窗，一盏灯。<br>
灯下的人互不相识，也不必相识。
</i></p>

<br>

Vela 是拉丁文里的「帆」，也是南天的船帆座。

它为每个环境备好一整套身份：指纹、代理、Cookie、登录状态，各归各的，互不相通。打开的环境铺在同一面墙上，实时可见，随手可点。数据只留在你的电脑上：没有账号，没有云端，也不用登录。

<br>

## 一面墙

<p align="center"><i>
一个分组是一行，一行是一条河。<br>
相邻的两条河逆向而流，岸上的灯火彼此相望。
</i></p>

打开 Vela，迎面就是工作台。每个运行中的环境是墙上一块实时画面；行可以首尾相接、循环流动，相邻两行反向缓缓漂移。

- **直接操作**：双击任意一块即可放大，在里面点击、输入、滚动，和操作真实窗口一样。
- **同步**：把一个环境设为主控，其余环境跟着它点击、键入。横幅第一行的涟漪就是这样一起泛开的。
- **分组**：只看某一行，或者让当前行在墙上占据更大的位置。
- **安静**：Windows 上可以让环境窗口不出现在任务栏。只去掉任务栏按钮，窗口本身和网页能读到的一切都不变。

导航收在底部的浮动坞里，其他页面从下方升起，按 <kbd>Esc</kbd> 回到墙上。默认是纸白色，入夜有深色。

## 每个环境，一套身份

<p align="center"><i>
同一台电脑，千种来路。<br>
各自的口音，各自的指纹，各自的回家的路。
</i></p>

- **内核**：Vela Chromium 155、CloakBrowser 和 Vela Firefox，每个环境单独选择；WebKit 处于实验阶段。
- **指纹**：屏幕、字体、语音、媒体设备、WebGL、WebRTC 等参数按环境生成，从第一次打开到最后一次关闭始终如一。
- **代理**：每个环境配置自己的 HTTP、HTTPS 或 SOCKS5 代理，可以检测连通性。环境往外发的请求都走它自己的代理，包括 AI 和插件替它发的，不另找路。
- **会话**：关闭时保存 Cookie 和本地存储，下次打开原样恢复。
- **批量**：分组、导入导出、回收站和定时任务。

## 熄灯，不散场

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cooling-dark.svg">
    <img src="docs/assets/cooling-light.svg" alt="内存占用升过阈值线，最久无人照看的那个浏览器冷却熄灯，内存回落；之后被双击唤醒。" width="100%">
  </picture>
</p>

<p align="center"><i>
夜深了，最久没人照看的那扇窗先熄灯。<br>
你回来的时候，桌上的茶还温着，书还翻在那一页。
</i></p>

窗口开得多了，内存总有吃紧的时候。系统内存占用连续越过阈值，Vela 就挑出闲置最久的那个浏览器，像你亲手点了「关闭」那样，先把会话存好，再把它关掉，把内存还给系统。

- 它不会从墙上消失，只是暗下来，标着「已冷却」。点「唤醒」，或者双击它，登录状态和标签页都在原处。
- 正在被你、脚本或 AI 使用的浏览器从不冷却；刚刚动过的也不会。
- 默认在内存占用达到 85%、闲置超过 10 分钟时开始，两项都能在设置里调整，也可以整个关掉。

## 交给 AI

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/agents-dark.svg">
    <img src="docs/assets/agents-light.svg" alt="一个 AI 同时连着三个浏览器窗口，每个窗口有自己的指针，各按各的节奏点击和输入。" width="100%">
  </picture>
</p>

<p align="center"><i>
一个念头，分作三双手。<br>
各写各的字，谁也不碰谁的笔。
</i></p>

Vela 自带 MCP 服务。Claude Code、Cursor 等 AI 工具接上之后，就能创建环境、打开浏览器、操作网页。

- **拟人输入**：指针沿带加减速的曲线移动，偶尔略过头再落定，落点散在元素内部；需要时用滚轮滚动；文字逐键输入，有快有慢，有停顿。每个环境的手速和习惯固定，环境之间各不相同。
- **一窗一鼠标**：每个浏览器窗口有自己的指针和键盘。AI 可以同时操作多个窗口，彼此不抢，也不会动你桌上的鼠标。
- **看得见 F12 里的东西**：控制台与异常堆栈、网络请求与原始响应、WebSocket 消息、DOM 与样式、Cookie 和站点存储，都能读；JavaScript、存储修改、经由环境自身网络发出的请求，都能写。Chromium 还能直接下发 CDP 命令。三个内核都接的是环境原本的上下文，隔离、代理和指纹一样不少。
- **先问一声**：只读的工具和会修改东西的工具分开标注，AI 客户端可以据此在动手之前先问你。读 Cookie 时默认只给当前页面会带上的那些，整个环境的要另外开口。
- **可开可关**：用 `aliasmode_humanize` 关掉拟人输入，或调整整体速度。

另有一套本地 HTTP 接口，与 AdsPower 的 `/api/v1` 风格兼容，可以从脚本里启动环境，再用 Playwright 或 Puppeteer 连接。JS 脚本还能用 `devtools.call(...)` 读取运行期间的控制台和网络记录。

## 插件

<p align="center"><i>
给 AI 添一件趁手的工具，<br>
只在它此刻所在的那扇窗里用。
</i></p>

在数据目录的 `plugins` 文件夹里放一个文件夹，AI 就多出几样本事。一份清单，一个模块：

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

AI 看到的是 `plugin_page_info_summary`。插件在 AI 选中的环境里运行，拿到的是那个环境自己的上下文：同样的登录、同样的代理、同样的指纹。它关不掉浏览器，各环境之间的状态也互不相通。Chromium、Firefox 和 WebKit 都能用。

「设置 → 高级 → 插件」里可以看到每个插件和它的工具，逐个开关，或者一键放入示例插件。写法见 [`docs/plugins.md`](docs/plugins.md)。插件是在你电脑上运行的代码，只装你信得过的。

## 安装

在 [Releases](https://github.com/accomplish07zrh-eng/vela-browser/releases) 下载 Windows 安装包。macOS 和 Linux 可以用安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/accomplish07zrh-eng/vela-browser/main/scripts/install-macos.sh | bash
```

```bash
curl -fsSL https://raw.githubusercontent.com/accomplish07zrh-eng/vela-browser/main/scripts/install-linux.sh | bash
```

应用内更新使用独立签名，只接受本仓库发布的版本。

## 从源码构建

需要 [Bun](https://bun.sh) 1.4.1 或更高版本；构建桌面版还需要 Rust 和 [Tauri](https://tauri.app) 的依赖。

```bash
bun install
bun test
bun start
```

打包 Windows 桌面版：

```bash
bun run desktop:prepare
bun run desktop:build:nsis
```

README 里的动图由 `python scripts/make-readme-art.py` 生成，都是带 CSS 动画的 SVG；系统开了「减少动态效果」时，它们会安静地停住。

## 目录

| 位置 | 内容 |
| --- | --- |
| `src/` | 环境管理、启动器、指纹、代理、冷却、插件清单和本地服务 |
| `web/` | 界面：工作台、浮动坞和各个页面 |
| `src-tauri/` | 桌面外壳、安装器、应用内更新 |
| `agent/` | MCP 服务、开发者工具、插件运行、拟人输入、脚本运行器 |
| `scripts/` | 打包、安装、验收和 README 插图脚本 |
| `docs/` | 插件与开发者工具说明，本地 API 和 MCP 工具的公开说明 |
| 根目录 `*.mjs` | 浏览器后台进程；打包后与 `agent/` 同层，所以留在根目录 |

## 致谢与许可

Vela Browser 是 [AliasMode](https://github.com/aliasmode/aliasmode) 的独立分支，与上游项目及其维护者没有隶属或背书关系。

- 应用代码沿用 Apache License 2.0，原始代码版权归 Xreacher 所有。
- AliasMode Firefox 内核采用 MPL-2.0，AliasMode Chromium 内核采用 GPL-3.0。
- CloakBrowser 是第三方内核，适用其自身的许可条款。
- 字体、语音与媒体设备数据等第三方资源的版权和许可见 [`NOTICE`](NOTICE)。

<br>

## In English

<p align="center"><i>
Every window keeps its own lamp.<br>
The people beneath them never meet, and never need to.
</i></p>

Vela is Latin for *sails*, and the name of a southern constellation. Vela Browser is a local-first anti-detect browser. Every environment carries its own fingerprint, proxy, cookies and sessions, and all running environments live on one wall of live views that you can watch and use directly. There are no accounts and no cloud; your data stays on your computer.

When memory runs short, the browser left alone the longest is saved and closed, and stays on the wall marked as cooled. Wake it, and it comes back signed in, with its tabs.

AI agents connect through the built-in MCP server. Clicks, hovers and typing are human-like by default, and every browser window has its own independent pointer and keyboard, so an agent can drive many windows at once without touching your real mouse. The developer tools read and write what F12 shows: console, network, WebSocket frames, DOM, storage, JavaScript, and CDP on Chromium. Each environment keeps its isolation, proxy and fingerprint while they run. Plugins in the `plugins` folder add tools of your own, in every engine; see [`docs/plugins.md`](docs/plugins.md). A local HTTP API in the style of AdsPower's `/api/v1` serves scripts.

Vela Browser is an independent fork of [AliasMode](https://github.com/aliasmode/aliasmode) under the Apache License 2.0, and is not affiliated with or endorsed by the upstream project. See [`NOTICE`](NOTICE) for third-party terms.
