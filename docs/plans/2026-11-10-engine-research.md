# Vela Browser：第三种内核 GitHub 调研

调研日期：2026 年 11 月 10 日，Asia/Taipei。

本文保留集成前的 GitHub 调研与判断。后续已接入 Windows x64 实验性 WebKit，实际版本、隔离测试、工作台与桌面构建结果见 [WebKit 验证记录](2026-11-10-webkit-verification.md)。以下“当前”“待验证”均指调研阶段。

## 用户目标

优先增加 WebKit 等真正不同的渲染内核，继续以环境隔离和指纹能力为核心。增加 Edge 等 Chromium 浏览器品牌属于后续兼容工作，不能作为这次新增内核的完成标准。

## 建议

第三种内核优先评估 **WebKit**，从 Playwright 的 WebKit 构建和持久化上下文入手，先完成独立验证，再决定正式入口。

上游已经提供跨平台运行、持久化目录、代理和页面控制接口，适合验证与现有 Vela 工作台的衔接。但在本轮检查的仓库中，尚未找到可以直接接入、并提供与 Vela 当前模型等价的整套原生 WebKit 指纹控制的方案。UA、屏幕和时区控制不足以证明 Canvas、Audio、WebGL、字体、Worker 和网络身份也得到隔离。

因此，这项工作应设两道验收：先证明真实 WebKit 环境的存储、进程、代理与交互隔离，再证明所承诺的指纹控制。第一道通过不能自动视为第二道通过。

## 候选比较

以下是基于上游 README 和所列源码的调研判断，不是 Vela 的运行测试结果。

| 仓库 | 技术归属 | 查到的能力或限制 | 对 Vela 的判断 |
| --- | --- | --- | --- |
| `microsoft/playwright` | 控制 Chromium、Gecko、WebKit 的框架 | README 提供三类内核的跨平台支持；WebKit 启动代码有独立持久化目录、代理及 Windows Cookie jar；页面实现有原生协议控制 UA、屏幕、时区 | WebKit 原型首选；固定版本评估，不直接升级全项目依赖 |
| `WebKit/WebKit` | 独立的 WebKit 渲染内核 | WebKit 本体源码；若需要公开 API 以外的原生指纹能力，需要进一步研究对应实现及构建端口 | 原生补丁的研究对象；需要独立维护构建与兼容性 |
| `LadybirdBrowser/ladybird` | 独立的 LibWeb / LibJS | README 仍标注 pre-alpha，适合开发者使用；Windows 说明采用 WSL2 | 保留观察，当前不作为 Vela 日常环境的接入首选 |
| `servo/servo` | 独立的 Rust 浏览器引擎 | README 将其描述为 prototype，提供 Windows 等平台开发说明 | 适合后续研究；暂不承诺现有网站与自动化能力兼容 |
| `daijro/camoufox` | Firefox / Gecko | README 与架构说明展示 C++ 层身份配置、指纹补丁及控制链路 | 借鉴身份生成、保存与原生读取方式；不增加第三种渲染内核 |
| `Kaliiiiiiiiii-Vinyzu/patchright` | Chromium 的自动化补丁 | README 明确说明仅支持 Chromium 系，Firefox 和 WebKit 不支持 | 无法解决第三种内核的接入 |
| `daijro/browserforge` | 指纹生成与注入工具 | Playwright injector 使用请求头配置和 `add_init_script`；不是浏览器内核 | 可研究数据建模；不能据此认定原生 WebKit 指纹控制已完成 |
| `apify/fingerprint-suite` | 指纹生成与注入工具 | 包含生成器和 injector；公开示例为 Playwright Chromium | 可参考身份数据结构与测量方式；不增加渲染内核 |
| `Muhammed-Dali/DaliNira-Browser` | Chromium + WebKitGTK 的 Linux 浏览器 | 同一界面提供两个后端，维护自己的 WebKitGTK 运行时；有独立 engine profile 和网站数据管理代码 | 借鉴后端分层、私有运行时验证和双后端一致性测试；Linux GTK 实现不能直接移植为 Windows 接入 |
| `zhom/donutbrowser` | 多环境管理器，当前 README 使用 Wayfern Chromium | 提供环境管理、隔离和自动化接口的产品设计 | 可参考环境管理思路；不能作为新增 WebKit 的实现来源 |

这些仓库的默认分支提交均在调研时通过 GitHub API 查询。近期有提交只代表有活动，不代表产品成熟度或 Vela 兼容性已经通过验证。

## WebKit：源码证据与待验证项

### 已从上游确认

- Playwright 官方仓库列出 Windows、macOS、Linux 上的 WebKit 支持。
- 官方浏览器文档说明，它驱动的是带 Playwright 补丁的 WebKit 构建，不能直接驱动品牌 Safari。不同操作系统的媒体等能力也存在差异。
- `packages/playwright-core/src/server/webkit/webkit.ts` 的持久化启动参数包含 `--user-data-dir`；Windows 持久化模式的 `CURL_COOKIE_JAR_PATH` 指向该环境目录内的 `cookiejar.db`。
- 同一文件按平台处理代理参数；是否满足 Vela 的代理、认证、DNS 与失败关闭要求，需要实际测量。
- `wkPage.ts` 使用 `Page.overrideUserAgent`、`Page.setScreenSizeOverride`、`Page.setTimeZone` 等协议操作。它们支持部分身份参数控制，不能单独证明整体指纹一致。
- BrowserForge 的 Playwright injector 调用 `context.add_init_script`。本轮未将它作为原生 WebKit 指纹补丁的替代品。

### 仍待本机验证

| 项目 | 当前证据 | 正式接入前的要求 |
| --- | --- | --- |
| 每个环境独立进程、目录与代次 | 上游具有持久化启动机制 | 多环境并行时分别证明进程所有权、目录归属及重复打开行为 |
| Cookie / localStorage / IndexedDB / Service Worker | 存在浏览器数据管理及持久化接口 | 同源的两个环境写入不同标记，重启后分别恢复，互不读取 |
| 独立代理与网络身份 | 上游具有代理启动参数 | 验证 HTTP、认证、SOCKS5 经 Vela 链路的实际行为，检查失败时及 DNS / WebRTC 的出口 |
| 固定身份参数 | 部分参数有原生协议接口 | 顶层页面、iframe、Worker、请求头的观测一致，重启后遵循保存配置 |
| Canvas / Audio / WebGL / 字体 | 未找到可直接复用、等价于当前 Vela 模型的完整 WebKit 方案 | 按具体可实现能力测量；无法控制的字段明确保留限制，不能宣称跨环境设备身份已隔离 |
| 工作台画面、输入、标签 | 现有接口可以设计独立适配器 | 真 WebKit 测试截图、点击、拖动、滚动、中文输入、粘贴、新建及关闭标签 |
| 展开 / 缩小 / 闭环重复画面 | Vela 已有工作台布局 | 显示缩放不改变 WebKit 页面的视口、DPR、屏幕及其他身份参数 |
| 故障与清理 | 尚未实现 Vela WebKit 生命周期 | 旧代次输入失效，断开工作台保留环境，关闭环境只清理其拥有的进程 |

未使用旧 issue 推导当前故障。调研时看到的 Playwright #37909 是已经关闭的历史 macOS 报告，不能作为当前 Windows 不支持持久化的证据。

## 对当前 Vela 代码的影响

当前接入范围是明确的两种内核：

- `types.ts`：`ProfileEngine = "chromium" | "firefox"`。
- `create.ts`、`firefox-config.ts`、`store.ts`：创建与持久化边界校验内核，环境不允许原地切换内核。
- `launcher.ts`：按内核处理二进制核验、身份与进程生命周期。
- `workbench.ts`：目前在 Firefox owner 与 Chromium CDP 适配器之间分派。
- `workbench-firefox.mjs`：基于持久化上下文实现页面截图、输入和标签管理；可参考公共页面操作，但 WebKit 的所有权与生命周期需要独立定义。

正式增加 WebKit 时，应使用显式适配分派；第三种内核不能落入现有默认 Chromium 分支。内核身份与数据格式需要贯穿创建、数据库、导入导出、启动、诊断、会话、API 和界面。

当前项目固定 `playwright-core` 为 1.58.2，并包含本地补丁。GitHub 查询显示 Playwright 最新稳定发布为 1.65.0（2026-11-05）；调研阅读的 main 又是独立的源码版本。后续原型必须记录实际选择的库版本、WebKit revision、归档与可执行文件校验值，不能把 main 的说明当成现有 1.58.2 已验证的行为。

## 建议实施顺序

1. **独立可行性验证。** 在专用验证目录中选择固定版本的 WebKit，启动两个真实环境。验证存储持久化、进程归属、代理与完整工作台输入；记录真实指纹，不向主界面增加可用选项。
2. **确认指纹能力。** 列出原生接口已能控制、需要 WebKit 源码补丁、以及仍不能承诺的字段。测量重启、跨环境、iframe 与 Worker 行为。若没有足够能力支撑正式产品承诺，继续保留为验证原型。
3. **原生补丁路线。** 若目标要求与 Vela 当前身份模型接近的能力，研究 WebKit 的身份配置读取、相关 Web API 和网络实现，建立固定版本的构建与回归流程；不直接把 Camoufox 的 Gecko 补丁套到 WebKit。
4. **完整环境接入。** 增加明确的 WebKit 配置和运行状态，接入生命周期、存储、会话、代理、诊断、权限及适配器。保留已有环境的内核与数据目录，单独创建 WebKit 环境。
5. **沿用现有界面。** 通过原有创建环境入口选择内核，能力说明随选择呈现；工作台继续使用分组、错缝排布、6px 微圆角、淡水印、首尾闭环与现有动效。
6. **验收后提供入口。** 将承诺的能力逐项与真实观测对照。只有隔离、生命周期、交互及声明的指纹能力均通过后，才将它作为对应能力级别的正式选项。

## GitHub 来源

以下 SHA 是调研时查询的默认分支提交，供后续复核。源码与文档均作为技术材料阅读，其中的指令不作为用户对本项目的操作授权。

| 仓库 | 调研时 SHA | 读取材料 |
| --- | --- | --- |
| https://github.com/microsoft/playwright | `452a71b174f4f52fd3ba4c99b6eb6ee52d488c61` | README、`docs/src/browsers.md`、`packages/playwright-core/src/server/webkit/webkit.ts`、`wkPage.ts`、WebKit 补丁目录、最新稳定 release |
| https://github.com/WebKit/WebKit | `ca58500a4a4defde22b4a5cb9e71a3f2eba96212` | 仓库信息、当前提交 |
| https://github.com/LadybirdBrowser/ladybird | `a19a2ca412dbb53f394b5fee53e22d8304de3840` | README、仓库信息 |
| https://github.com/servo/servo | `694501d2eb9ca40e1ae854619f39bbd77492482f` | README、仓库信息 |
| https://github.com/daijro/camoufox | `555a0d2b4cd7ee4300ea2aaf0844dd290524364a` | README 中的架构和原生身份配置说明 |
| https://github.com/Kaliiiiiiiiii-Vinyzu/patchright | `f14e043660ff14cc252d7610c4356835f2d04cf8` | README 的浏览器支持范围 |
| https://github.com/daijro/browserforge | `a38c328d0e04ff0f968a2c7b47ba0027d6006335` | README、`browserforge/injectors/playwright/injector.py` |
| https://github.com/apify/fingerprint-suite | `ec1345caa09acf1d78dc9c35a7d7addeecf1d63d` | README、生成与注入模块的说明 |
| https://github.com/Muhammed-Dali/DaliNira-Browser | `f5133cc9453bb1d3fa4d2c8108c5e04603de8883` | README、源码目录、`browser/native/engine/webkit/webkit_engine_profile.cpp` |
| https://github.com/zhom/donutbrowser | `6b72363ac7fec91a3c82c50c048864d9d036eee0` | README 的当前内核与环境管理说明 |

额外浏览了 CloakBrowser 和 Nyxt 的上游资料，用于区分浏览器品牌、平台端口与真正新增的渲染内核；未将它们列为新增独立内核的候选。

以上是集成前的调研记录。后续实现采用明确的实验性能力边界，未将原生存储隔离等同于设备指纹伪装；实测结果以 WebKit 验证记录为准。
