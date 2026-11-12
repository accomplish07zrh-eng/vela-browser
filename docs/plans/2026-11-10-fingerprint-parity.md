# 指纹能力全量补齐与验收

2026-11-10，台北时间。目标是补齐 AdsPower、Multilogin 公开描述的浏览器指纹控制，并用真实测量验证稳定性、环境差异与跨上下文一致性。功能范围是浏览器指纹与环境隔离，不涉及购买第三方账号、绕过网站权限或修改付费产品。

## 验收规则

- 配置存在、浏览器实际生效、通过稳定性验收，分别记录。没有测到不能算通过。
- 同一环境至少三次独立启动、同次启动重复读取、新标签、同源和跨源 iframe、Dedicated/Shared Worker、Service Worker 中分别采样。API 本来不存在时记为不可用。
- 多环境区别比较真实渲染/采样结果；相同显卡型号或相同原生音频结果本身不判为隔离失败。
- 对合法读写进行校验：Canvas put/get、透明与纯色像素、音频静音和常量、字体回退与布局。稳定扰动不能破坏这些功能。
- 操作工作台、侧栏、缩放和视口展开不重生成身份。进程、Cookie、存储、代理保持每环境独立。
- 旧环境保持已有身份。内核或策略变更必须显式迁移，不在启动时随机换种子、静默替换 UA 或套用新 GPU。
- 所有内核版本、源码提交、补丁及二进制均可追溯。JavaScript 注入不能标成原生内核能力。

## 全量矩阵

| 范围 | 需要覆盖的表面 | 验收重点 |
| --- | --- | --- |
| Canvas | toDataURL、toBlob、getImageData、OffscreenCanvas、文本绘制 | 同一内容稳定，合法像素往返不被破坏 |
| Audio | OfflineAudioContext、AudioBuffer 读写与 copyFromChannel、Analyser、采样率、延迟、通道数 | 渲染与读取一致；静音、常量不被错误扰动 |
| 图形 | WebGL1/2 参数、扩展、shader precision、readPixels、WebGPU adapter/features/limits | 型号、能力、渲染结果相互匹配；不承诺虚拟化真实硬件 |
| 字体 | 可见字体集合、fallback、Canvas TextMetrics、DOM 布局、CSS system-ui、字体包 | 系统人设一致，字体确实可用，布局可读 |
| 浏览器身份 | UA、UA-CH 高低熵值、platform、版本与架构、webdriver | HTTP 与 JS、页面与 Worker 的返回值一致 |
| 地域 | language/languages、Accept-Language、Intl、timezone、地理定位与权限 | 代理出口、语言时区与用户选择协调 |
| 屏幕与输入 | screen/available/colorDepth/DPR、viewport、触控、pointer/hover、媒体查询 | 工作台操作不改变配置身份 |
| 硬件 | hardwareConcurrency、deviceMemory、存储配额、GPU 能力 | 不报告超出物理可服务能力的值 |
| 媒体 | camera/microphone/speaker 枚举、deviceId/groupId、语音列表 | 环境间不共享宿主标识；权限与设备可用性一致 |
| 网络 | HTTP/HTTPS/SOCKS5、认证、WebRTC、DNS 路径、TLS/HTTP 指纹 | 失败不直连、不切到另一个环境；网络栈限制单列实测 |
| 隔离与迁移 | 进程、Cookie、localStorage、IDB、CacheStorage、SW、会话、Cloud/导入导出 | 不串环境；重启及迁移结果有证据 |

## 实施顺序与状态

1. **检测与回归基线，进行中。** 扩展现有采样：增加 Canvas 像素、WebGL 真实渲染、字体集合、文字度量、音频采样及重复读取；修复只比较 Canvas 重启、把 GPU 型号当渲染指纹、无采样仍显示唯一等问题。加本地指纹报告及代次保护。
2. **三内核实测，待完成。** 使用独立 QA 环境，不操作用户账号；分清现有内核真正支持与未实现项。
3. **原生实现补齐，待完成。** Chromium/Firefox 沿用可追溯内核补丁；WebKit 需要独立维护源码补丁、构建链、版本与哈希，完成实际浏览器验收后才能启用相应能力。不能将当前 Playwright 官方 WebKit 标成完整指纹内核。
4. **策略、持久化与界面，待完成。** 能力经验证后再开放配置，按内核隐藏或解释不支持项。保持现有简洁界面与环境身份，覆盖 Local/Cloud/导入导出/portable。
5. **全量发布门槛，待完成。** 三内核逐项验收，重启与跨上下文回归，打包原生桌面复测。未验收项保持明确状态。

“超越”以可审计源码、自动回归、逐项证据、隔离和稳定性为指标；没有对两款付费产品在相同硬件、版本与测试下实测前，不宣称整体优于它们。

## 参考

- AdsPower 官方 Fingerprint configuration：<https://localapi-doc-en.adspower.com/docs/Awy6Dg>
- Multilogin 官方 Fingerprint section：<https://multilogin.com/help/en_US/profile-behavior-identity/profile-settings-fingerprint-section>
- Multilogin 官方 Fingerprint mismatches：<https://multilogin.com/help/en_US/fingerprints/the-truth-about-fingerprint-mismatches>
- 原生内核参考：`aliasmode/aliasmode-chromium`、`aliasmode/aliasmode-firefox`、`microsoft/playwright/browser_patches/webkit`。WebKit 当前基线为 Playwright 1.65.0 / revision 2388，WebKit 源码 `5b391e6d3b14d549908dad2c6695999291313f30`。

## 2026-11-10 实测进展

- 本地 probe / audit / attestation 已接入真实数据，覆盖重复读取、跨上下文和合法读写；界面分别呈现支持、缺失、差异与未验证项。
- 三内核真实验收 `reports/fingerprint-acceptance.json`：44 项通过、20 项失败。此结果不是“全量通过”。此前专项测试 54 项通过，相关回归 326 项通过、19 项跳过。
- Chromium：Shared / Service Worker 的 generic 字体映射原生补丁已保存于 `kernels/chromium/patches/0001-worker-generic-fonts.patch`，尚未编译成浏览器并重新验收。
- Firefox：Arial Black 首次读取及跨上下文字体稳定性仍有失败，尚未解决。
- Windows WebKit：当前官方运行时 Worker 无 OffscreenCanvas、Audio 表面缺失，不能标记为完整指纹内核。保存种子的 Canvas / 字体原生补丁和头文件已写入 `kernels/webkit`；独立头文件编译与种子稳定性检查通过，但不等于浏览器验收通过。
- WebKit 构建：23 个依赖已构建；构建脚本修正了头文件路径和仅换行差异的校验。ConfigureOnly 仍因缺少 Ruby ≥ 2.5 失败，见 `reports/webkit-configure.log`。没有产出已验收的新 WebKit 产品运行时。
- 原生源码基线：WebKit `5b391e6d3b14d549908dad2c6695999291313f30`；Playwright `a1f35e1955976e84411f9c10358228a80b763ebe`。
- 画廊工作台另行通过 12 个 QA 环境的 Cookie / localStorage / 输入隔离，以及聚焦前后 viewport / screen / DPR 不变的检查。该结果证明此工作台操作没有改变测试身份，不能替代上面的指纹验收。

下一步需完成原生运行时构建、修复失败表面并重跑同一矩阵；保持旧身份不变。没有用 JavaScript API 覆盖冒充原生指纹能力。
