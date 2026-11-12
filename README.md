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
灯下的人互不相识，<br>
也不必相识。
</i></p>

<br>

Vela，拉丁文里的「帆」，也是南天的船帆座。

每个环境都是一扇窗，\
窗里住着一个完整的人：\
自己的指纹，自己的代理，自己的 Cookie 和登录，\
各自关在各自的屋里，从不串门。

所有的窗都开在同一面墙上，\
你看得见每一盏灯，伸手就能推开。

而这一切只留在你的电脑里：\
没有账号，没有云端，\
不必向谁报到。

<br>

## 一面墙

<p align="center"><i>
一个分组是一行，一行是一条河。<br>
相邻的两条河逆向而流，<br>
岸上的灯火，隔水相望。
</i></p>

打开 Vela，墙就在眼前。\
每一块都是活的：一个正在运行的浏览器，此刻的样子。

- **双击，它便迎上来。** 放大之后点击、输入、滚动，和真的窗口没有两样。
- **一人领唱，众人相和。** 把一个环境设为主控，其余的跟着它点击、键入；横幅第一行那几圈同时泛开的涟漪，就是这样来的。
- **只看这一行。** 或者让眼下这一行在墙上多占些地方。
- **不在任务栏留名。** Windows 上，环境窗口可以不出现在任务栏。只是少了那个按钮，窗口本身，和网页能读到的一切，都不变。

导航收在底部的浮动坞里，别的页面从下方升起；\
按 <kbd>Esc</kbd>，回到墙上。\
白天是纸白，入夜换上深色。

## 每个环境，一套身份

<p align="center"><i>
同一台电脑，千种来路。<br>
各自的口音，各自的指纹，<br>
各自回家的路。
</i></p>

- **三种内核，任选其一。** Vela Chromium 155、CloakBrowser、Vela Firefox，每个环境自己挑；WebKit 还在试航。
- **一张脸，从生到灭。** 屏幕、字体、语音、媒体设备、WebGL、WebRTC，按环境生成；从第一次打开到最后一次关闭，始终是同一张脸。
- **一条自己的路。** 每个环境配自己的 HTTP、HTTPS 或 SOCKS5 代理，通不通可以先测。它往外发的请求，连同 AI 和插件替它发的，都只走这一条路。
- **合上，再打开，一切如旧。** 关闭时收好 Cookie 和本地存储，下次原样摊开。
- **成群地照料。** 分组、导入导出、回收站、定时任务。

## 熄灯，不散场

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cooling-dark.svg">
    <img src="docs/assets/cooling-light.svg" alt="内存占用升过阈值线，最久无人照看的那个浏览器冷却熄灯，内存回落；之后被双击唤醒。" width="100%">
  </picture>
</p>

<p align="center"><i>
夜深了，最久没人照看的那扇窗先熄灯。<br>
你回来的时候，茶还温着，<br>
书还翻在那一页。
</i></p>

窗开得多了，内存总有不够的时候。\
当占用接连越过那条线，Vela 就找出闲置最久的那一扇，\
像你亲手点下「关闭」那样：先把会话收好，再轻轻合上，\
把内存还给这台电脑。

- **它不会离开墙。** 只是暗下去，标着「已冷却」。点「唤醒」或者双击它，登录还在，标签页也还在。
- **有人在的窗不熄。** 你正用着的，脚本或 AI 正操作着的，刚刚才碰过的，都不会被冷却。
- **那条线由你来画。** 默认是内存占用 85%、闲置 10 分钟；两项都能在设置里改，也可以整个关掉。

## 交给 AI

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/agents-dark.svg">
    <img src="docs/assets/agents-light.svg" alt="一个 AI 同时连着三个浏览器窗口，每个窗口有自己的指针，各按各的节奏点击和输入。" width="100%">
  </picture>
</p>

<p align="center"><i>
一个念头，分作三双手。<br>
各写各的字，<br>
谁也不碰谁的笔。
</i></p>

Vela 自带 MCP 服务。\
让 Claude Code、Cursor 这样的 AI 接上来，它就能建环境、开浏览器，在网页里做事。

- **一双像人的手。** 指针沿着有快有慢的曲线走，走得远了，有时会略过头再拉回来；落点散在元素里，不总在正中。字一个键一个键地敲，逢着标点会停一停。每个环境的手速和习惯定下来就不再变，环境与环境之间各不相同。
- **一扇窗，一只鼠标。** 每个窗口有自己的指针和键盘。AI 可以同时照看好几扇窗，互不争抢，也不会碰你桌上的那只鼠标。
- **F12 里的东西，它都看得见。** 控制台与异常堆栈、网络请求与原始响应、WebSocket 消息、DOM 与样式、Cookie 与站点存储，都能读；运行 JavaScript、改存储、借环境自己的网络发请求，都能写；Chromium 上还能直接下发 CDP 命令。三个内核用的都是环境原本的那一个上下文，隔离、代理、指纹，一样不少。
- **动手之前，先问一声。** 只读的工具和会改动东西的工具分开标注，AI 客户端可以据此先问过你。读 Cookie 时，默认只给当前页面会带上的那些；要整个环境的，得另外开口。
- **快慢由你。** 用 `aliasmode_humanize` 关掉拟人输入，或者调整整体的速度。

还有一套本地 HTTP 接口，和 AdsPower 的 `/api/v1` 说同一种话：\
从脚本里启动环境，再用 Playwright 或 Puppeteer 接上。\
JS 脚本也能用 `devtools.call(...)`，翻看运行期间的控制台和网络记录。

## 插件

<p align="center"><i>
给 AI 添一件趁手的工具，<br>
只在它此刻站着的<br>
那扇窗里用。
</i></p>

在数据目录的 `plugins` 里放一个文件夹，\
一份清单，一个模块，AI 就多会一样事：

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

AI 看见的名字是 `plugin_page_info_summary`。

插件只在 AI 选中的那个环境里干活，\
用的是那里的登录、那里的代理、那里的指纹；\
它合不上浏览器，也串不到别的窗里去。\
Chromium、Firefox、WebKit，处处可用。

「设置 → 高级 → 插件」里，每个插件和它的工具都摆在那儿，可以逐个开关，也可以一键放进一个示例。\
写法见 [`docs/plugins.md`](docs/plugins.md)。\
插件是在你电脑上运行的代码，只请信得过的进门。

## 安装

<p align="center"><i>
一个安装包，或者一行命令。
</i></p>

在 [Releases](https://github.com/accomplish07zrh-eng/vela-browser/releases) 下载 Windows 安装包。macOS 和 Linux 可以用安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/accomplish07zrh-eng/vela-browser/main/scripts/install-macos.sh | bash
```

```bash
curl -fsSL https://raw.githubusercontent.com/accomplish07zrh-eng/vela-browser/main/scripts/install-linux.sh | bash
```

应用内更新有自己的签名，只认本仓库发出的版本。

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

这页上会动的图，出自 `python scripts/make-readme-art.py`，是几张带 CSS 动画的 SVG。\
系统若开了「减少动态效果」，它们便安静地停在原地。

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
The people beneath them never meet,<br>
and never need to.
</i></p>

*Vela* is Latin for sails, and the name of a southern constellation.

Every environment is a window,\
and behind it lives a whole person:\
their own fingerprint, their own proxy, their own cookies and sign-ins,\
each kept in its own room, never visiting the next.

All the windows open onto one wall.\
You can see every lamp, and reach any of them.\
Nothing leaves your computer: no accounts, no cloud, no one to report to.

When memory runs short, the window left alone the longest goes dark.\
Its session is saved before it closes, and it stays on the wall.\
Wake it, and it comes back signed in, with its tabs.

AI agents connect through the built-in MCP server.\
Every window has its own pointer and keyboard, moving and typing like a hand,\
so one agent can work many windows at once and never touch your mouse.\
It can read and write what F12 shows (console, network, WebSocket frames, DOM, storage, JavaScript, and CDP on Chromium)\
while each environment keeps its isolation, proxy and fingerprint.\
Plugins in the `plugins` folder give it tools of your own, in every engine; see [`docs/plugins.md`](docs/plugins.md).\
A local HTTP API in the style of AdsPower's `/api/v1` serves scripts.

Vela Browser is an independent fork of [AliasMode](https://github.com/aliasmode/aliasmode) under the Apache License 2.0, and is not affiliated with or endorsed by the upstream project. See [`NOTICE`](NOTICE) for third-party terms.
