# WebKit 接入与验证记录

2026 年 11 月 10 日 · 台北时间

## 交付范围

新增独立的 `webkit` 环境类型。目前限定 Windows x64，并在新建环境入口标注“实验性”。Chrome、Firefox 与 WebKit 共用现有环境管理和工作台界面；各自的浏览器进程、owner、资料目录、Cookie、网站存储及代理仍然独立。

新建环境 → WebKit 即可选择；首次运行下载固定版本并验证归档与可执行文件。已有环境不允许原地更换内核。TXT、XLSX 和 PortableProfile v5 保留 WebKit 配置，旧 portable 版本拒绝无法表达的内核。

工作台沿用错缝排列、6px 微圆角、8px 间距、角落约 20% 不透明度的名称及状态水印、分组筛选、每排首尾闭环，以及侧栏收展和视口展开动效。重复画面复用同一环境的连接，不额外启动浏览器。

WebKit 的画面、输入、标签与会话通过私有 owner 控制；不回退到 Chromium CDP。公开 API 与 agent 返回能力列表，隐藏 owner 地址、令牌与内部端口。实验性版本暂不提供公开 CDP、MCP 页面工具、脚本自动化、PDF 或 Chrome 扩展。

## 版本与校验

| 项目 | 固定值 |
| --- | --- |
| Playwright WebKit 专用依赖 | `playwright-webkit-core`，npm alias `playwright-core@1.65.0` |
| WebKit | 27.2，revision 2388，Windows x64 |
| 归档大小 | 65,443,702 bytes |
| 归档 SHA-256 | `0b390661995316d8f90fe0f7a0498f3a88c451c097fc8e4047342e1fbd36548b` |
| `Playwright.exe` SHA-256 | `191e2f0cfade1d4cde1c7e5155bda956effafd201e7ec22c92edbfb0d0c4c8f0` |
| 打包 Node | 22.23.2 |
| Bun 最低版本 | 1.4.1；Windows 构建会检查，仓库与 CI 已对齐 |

原有带补丁的 `playwright-core@1.58.2` 保留。WebKit 单独固定依赖和工作进程，没有整体升级原有浏览器控制库。

在 Bun 1.3.14 上复现了 Windows 子进程继承监听 socket 的问题：管理进程退出后，存活浏览器仍占住原代理端口。上游修复为 `oven-sh/bun#36938`；换用经过 SHA-256 核验的 Bun 1.4.1 后，同一验收中的独立进程重启与原端口重连均通过。构建检查在清理旧资源之前拒绝过旧 Bun。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| 相关回归，28 个测试文件 | 688 通过，1 跳过，0 失败，13,168 次断言 |
| Windows 打包检查，含最低 Bun 版本保护 | 7 通过，0 失败 |
| TypeScript | 通过 |
| Windows sidecar，x64 baseline | 编译通过，内置 Bun 1.4.1 |
| Windows Tauri 调试桌面构建 | 通过 |
| 独立 WebKit 可行性实测 | 9 项通过 |
| 真实 Launcher + 打包 Node 22 运行时 | 11 项通过 |
| 原生 Tauri 桌面工作台 | 两个 WebKit 环境交互通过，0 错误 |

回归覆盖创建、数据库、导入导出、portable、Cloud 编辑与生命周期、公开 API、agent、脚本拒绝、所有权、运行时、工作台、翻译及三平台打包逻辑；包括 Firefox 原有生命周期回归。这里统计的是相关测试集，不声称全部仓库测试均通过。此前完整仓库基线结果见 [工作台验证记录](2026-11-10-workbench-verification.md)。

原有两项源码字符串测试先规范化 CRLF；Python 下载测试等待真实状态完成；停滞代理测试读取收到的数据后再观察 EOF。这些调整保留了原有行为断言。

## 真实引擎验收

`scripts/webkit-launcher-acceptance.ts` 使用真实 Launcher、SQLite、Windows 进程扫描、浏览器工作进程、同源测试页面与两个独立认证代理。最终运行设置 `ALIASMODE_PLAYWRIGHT_RUNTIME` 指向桌面包内的运行目录，因此实际使用打包 Node 22.23.2 与已复制的固定依赖。

以下 11 项均通过：

1. 两个环境分别启动，进程与持久化目录归属通过认证。
2. 同源 Cookie、localStorage、IndexedDB、CacheStorage、Service Worker 互不读取。
3. 工作台真实截图、中文输入、点击、拖动、滚动、新建和关闭标签只作用于选定环境。
4. 旧 owner 代次不能读取或关闭替代实例。
5. 公开 API 展示 WebKit 能力，不泄露私有 RPC。
6. 新管理器重新接管同一 PID 与 owner 代次，不重复启动。
7. 受控停止并重开后，五类存储均保留。
8. 重开后的实际指纹与此前观测一致。
9. 两套环境分别使用自己的代理账号与中继端口。
10. 原管理器进程真正退出后，新管理器在各自原端口重建代理，浏览器 PID 保持不变。
11. 上游代理失败时，请求不切换到另一环境或直连路径。

另外验证了原生语言、时区、屏幕在页面、iframe 和 Worker 中的配置，以及视口和 DPR 在工作台显示操作前后保持不变。代理中继另有 HTTP、SOCKS5 与 HTTPS TLS 测试，包括可信证书成功和不可信证书拒绝；真实 WebKit 的代理端到端验收使用本地认证 HTTP 代理。尚未以外部代理出口或真实网站账号验收。

## 界面与桌面

Tabbit 中确认了第三个内核卡片、中文能力说明、不提供硬件及种子伪装编辑、真实页面画面、分组切换、6px 圆角与淡水印、正反向循环浏览、68px 侧栏收束、视口展开和 Esc 归位。Tabbit 的页面显示测试使用专用测试授权；实际桌面授权另行验证，不将测试注入视为桌面授权的证据。

原生 Tauri 调试桌面另在独立 QA 数据目录中完成了两个真实 WebKit 环境的交互检查，通过实际 `workbench_capability` 获取桌面授权。两个环境均完成中文输入、粘贴、保存按钮点击、拖动、滚动、新建与关闭标签、Esc 归位；逐项确认另一环境未受影响。两套视口与屏幕均保持 1280 × 800、DPR 1，结果为 `nativeAuthorization: true`、`errors: []`。检查使用打包 sidecar 与 Node 22.23.2；结束后关闭了本次 QA 的环境与桌面进程。

交互通过私有 owner 只读页面探针核对真实 DOM 状态，桌面画面也已截图查看。最终截图时页面停在滚动后的空白区域，故该图主要记录工作台排列与水印，不用它证明输入和拖动结果。原生结果文件记录了各环境各自的输入、点击计数、拖动状态与 320px 滚动位置。

## 指纹与会话边界

原生可配置语言、时区、屏幕、视口及 DPR；没有注入 `navigator`、Canvas、Audio、GPU 或字体伪装，也没有宣称不同环境具有不同设备指纹。

本机观测：UA 带 Mac Safari 样式，`navigator.platform` 为 Win32，`navigator.webdriver` 为 true，WebGL 报告 Apple Inc. / Apple GPU，hardwareConcurrency 为 8。Canvas 可采集且重启稳定；音频探针不可用，RTCPeerConnection 不可用。这些是本次 Windows 构建的实测，不应当作所有 WebKit 平台的统一结论。当前实现不等同于 Safari，也未达到 Chromium / Firefox 的原生指纹定制范围。

WebKit 自身保存持久化 Cookie 与网站存储。通过管理器受控关闭时，另保存并一次性消费该环境的原生 session Cookie 快照，避免旧登录状态再次复活。原生窗口直接关闭或进程崩溃时，未承诺同样保留 session Cookie；不能把受控重开的结果推广为崩溃恢复保证。HTTP 缓存清理不删除 CacheStorage，停止后自动缓存清理暂不用于 WebKit。

## 证据与复现

本地证据：

- `reports/webkit-final-regression-tests.log`、`webkit-final-typecheck.log`、`webkit-final-packaging-tests.log`。
- `reports/webkit-feasibility.json`：原始可行性检查。
- `reports/webkit-launcher-acceptance.json`、`webkit-packaged-runtime-acceptance.log`：最终 11 项产品与运行时检查。
- `reports/webkit-desktop-build.log`：桌面构建。
- `reports/webkit-native-interaction.json`、`webkit-native-workbench.png`：最终原生桌面授权与双环境交互；本次数据目录为 `reports/webkit-desktop-y0jquX`。
- `reports/webkit-create-preview.png`、`webkit-workbench-preview.png`：界面检查截图。

```powershell
bun run typecheck
bun test webkit.test.ts webkit-lifecycle.test.ts webkit-runtime.test.ts launcher-webkit.test.ts
bun test launcher-firefox.test.ts firefox-lifecycle.test.ts firefox-runtime.test.ts
bun test workbench.test.ts web/workbench-layout.test.ts dashboard-ui.test.ts web/i18n.test.ts
bun test proxy-relay.test.ts proxy-relay-tls.test.ts scripts/prepare-windows-bundle.test.ts
bun scripts/webkit-launcher-acceptance.ts
```

本机检查使用独立 QA 数据目录。完整 Windows 打包仍遵守原项目的 Firefox 构建来源和归档校验要求；本轮桌面调试构建复用已验证的 Firefox 与 Node 资源，再编译 sidecar、复制 WebKit worker 和固定依赖，没有替换 Firefox 的校验要求。尚未构建或发布正式安装器。
