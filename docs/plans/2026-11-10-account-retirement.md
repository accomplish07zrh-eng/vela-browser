# Vela 全产品账户体系移除与原生验收

2026-11-10 · 台北时间。依据用户确认：**整个产品移除账户体系**。

Vela 现在直接进入本地工作区。设置仅有「通用 / 高级」，保留画廊浅色与独立暖深色、语言、更新和本地诊断。

## 产品改动

- 删除产品登录、注册、验证码、找回密码、首次模式选择与模式切换。
- 删除账户头像与账户设置、团队与邀请、权限管理、代理商城、钱包与支付界面。
- 删除脚本发布与取消发布操作、远程 MCP 连接器和账户会话恢复入口。
- 正常启动不再创建 Cloud 认证、连接、同步队列或 MCP 隧道；不再读写系统账户凭据。
- 本地 MCP、脚本管理与运行、匿名公开脚本目录浏览和导入继续可用。
- 旧账户 API 在访问运行依赖之前统一返回 `410 / accounts_removed / Cache-Control: no-store`。
- 原 `__cloud-*` 内部命令明确报告功能已移除；CI 浏览器生命周期测试改用 `__browser-lifecycle-smoke`。

网站登录资料属于环境数据。环境中的 username、password、TOTP、Cookie、浏览器存储、代理和指纹 seed 继续保留。

## 配置与历史数据

全新配置直接使用本地模式。旧 `unconfigured / local / cloud` 配置在启动时原子写为 `local`，移除 `cloudUrl`，保留本地偏好；未知版本和损坏配置仍会报错。

本次迁移不改写本地环境身份。历史 Cloud 缓存与恢复档案保留供离线恢复，不自动合并进本地数据库。少量历史数据类型和独立恢复模块继续兼容旧格式，产品启动与界面已没有账户路径。

Windows 系统账户和第三方网站账户仍可能出现在浏览器资料导入限制、网站验证提示中，它们与已移除的 Vela 产品账户无关。

## 本地自动检查

| 范围 | 最终结果 | 本地证据 |
| --- | --- | --- |
| 配置迁移、账户 API、CLI、脚本、MCP、代理、回收站、管理界面与工作台 | 365 通过，0 失败；19 个文件 | `reports/accounts-regression.log` |
| Rust 原生库与 helper | 57 通过，0 失败 | `reports/accounts-rust-tests.log` |
| TypeScript | 通过 | `reports/accounts-typecheck.log` |
| 前端资源、sidecar 与 Tauri 桌面调试构建 | 通过 | `reports/accounts-frontend-build.log`、`reports/accounts-sidecar-build.log`、`reports/accounts-desktop-build.log` |
| Windows 安装验收脚本语法 | 通过 | `scripts/windows-installed-acceptance.ps1` |
| Git 差异空白检查 | 通过 | `reports/accounts-diff-check.log` |

额外加入真实 WebSocket 回归，验证 Bun 助手实际发送认证头与 `aliasmode-agent-v1` 协议。原生实连发现单数 `protocol` 选项没有发送协议名，已改为 `protocols`；源文件与打包资源同步修正。默认发现路径统一指向 `com.velabrowser.desktop`，仅接受 `local` 就绪状态。

本表是本次相关检查，仓库全量测试和三内核指纹验收另有记录。

## 最终构建的原生验收

使用真实 Tauri / WebView2、独立 QA 数据目录和原生能力，测试期间 12 个环境全部保持关闭。

- 从旧 Cloud 配置直接启动为本地工作区；保留 `localAnalytics` 与 `servicesHidden`，恢复档案哈希不变。
- 重新加载后没有自动账户 API 请求，界面没有账户入口、登录表单或模式选择；设置仅为「通用 / 高级」。
- 浅色、深色和中英文切换正常；侧栏可收至 68px、展开至 248px；Ctrl+K 与 Esc 正常。
- 本地脚本页可用，无发布或登录操作；筛选、保存筛选、详情抽屉、模板应用与批量命名预览通过。
- 详情和新建对话框约束键盘焦点，Esc 关闭并恢复焦点；700×560 窄窗对话框保持在画布内。
- 8 个旧账户接口在真实原生服务中返回 410；检查期间无 JavaScript 异常。
- 打包运行时、Windows 原生 helper 与 stdio MCP 均能读取 12 个本地环境；连接器和已移除的账户写操作被拒绝，退休工具不再出现在 MCP 工具列表。
- 12 个环境的身份摘要与既有基线一致，seed 各自独立；10 个先前新建环境仍无 Cookie，启动记录为 0。临时筛选与模板恢复为验收前状态。
- 主窗口和 sidecar 正常退出，就绪描述文件随退出清理。

证据：`reports/accounts-native-verification.json`、`reports/accounts-api-native.json`、`reports/accounts-mcp-verification.json`、`reports/accounts-migration-verification.json`、`reports/management-identity-verification.json`。

## 视觉复查与交付边界

已逐张检查最终设置浅色、设置深色、环境详情、新建预览与窄窗截图。保留暖纸色、暖墨色、衬线标题、单色图标和低饱和焦点，删除账户区域后没有新增头像或空占位。

截图位于 `reports/accounts-settings-light.png`、`reports/accounts-settings-dark.png`、`reports/accounts-profile-detail.png`、`reports/accounts-create-preview.png`、`reports/accounts-create-narrow.png`。这些报告与截图为本地验收产物。

交付为工作区代码与原生调试构建。本轮未制作或安装发布包；Windows 已安装版本的 CI 验收已改为 `local-upgrade`，本机实际执行的是相同界面/API 验收脚本与独立数据目录迁移验证。

画廊工作台其余后续项仍见 `2026-11-10-gallery-design.md`；指纹能力边界见 `2026-11-10-fingerprint-parity.md`。
