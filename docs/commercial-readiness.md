# Vela Browser 商业级验收

对标记录更新于 2026-11-22。Vela 以本地环境、Agent 和自托管 Worker 为主要运行方式。厂商文档用来确认产品能力，同机测试用来比较实际耗时、内存和恢复表现。

## 产品对标

| 产品 | 官方资料确认的能力 | Vela 要检验的工作流 |
| --- | --- | --- |
| AdsPower | 本地 API 支持环境管理和启停，动作日志按操作类别查询。[本地 API](https://localapi-doc-en.adspower.com/docs/Rdw7Iu) · [动作日志](https://help.adspower.com/docs/action_logs) | AdsPower V2 脚本迁移、批量启停、错误归因和同机性能。 |
| Multilogin | 工作区角色区分创建、导入、导出和转移，回收站可恢复环境。[角色](https://multilogin.com/help/en_US/workspace-roles-and-permissions) · [回收站](https://multilogin.com/help/en_US/profile-organization-sorting/how-to-use-trash-bin) | Agent 凭据和组权限可撤销，环境恢复保留原有数据。 |
| GoLogin | 文件夹角色区分运行、编辑和完整访问，并提供批量操作。[团队权限](https://support.gologin.com/en/articles/3452652-team-members) · [批量操作](https://support.gologin.com/en/articles/14323620-bulk-actions) | 大列表选择跨页有效，批量结果可追踪，权限变化影响后续操作。 |
| Dolphin Anty | 可按权限共享或转移环境，并提供独立 MCP 入口。[团队协作](https://docs.dolphin-anty.com/en/teamwork/teamwork-in-dolphin-anty) · [MCP](https://docs.dolphin-anty.com/en/api/dolphin-mcp) | Agent 的环境访问、任务委派、凭据轮换和失败恢复。 |
| Octo Browser | 支持回收站、删除保护、环境历史和按 Token 查询 API 操作。[环境管理](https://docs.octobrowser.net/en/profiles/edit-profiles/) · [动作日志](https://docs.octobrowser.net/en/start/account-settings/) | 批量变更保留审计线索，关键环境可防误删，历史操作可追踪到 Agent。 |
| MoreLogin | 支持批量分组及跨团队转移，且说明哪些数据可随环境迁移。[分组](https://support.morelogin.com/en/articles/10244822-profile-group-management) · [转移](https://support.morelogin.com/en/articles/10283525-transfer) | 批量迁移先显示字段及冲突，执行后可校验、可撤销。 |
| Kameleo | Local API 支持环境导入导出，本地与云端环境有明确的数据边界。[环境管理](https://developer.kameleo.io/tutorials/managing-profiles/) · [团队协作](https://developer.kameleo.io/concepts/teamwork/) | 固定内核可验证，新的本地实例可恢复加密备份和会话。 |
| Incogniton | 支持本地数据备份和指定环境恢复。[本地备份](https://docs.incogniton.com/account-management/cloud-saving/backup-locally-saved-data) | 备份可在空白数据目录验证，故障定位能区分配置、会话与内核。 |
| Nstbrowser | 支持批量创建、复制环境和团队权限控制。[批量创建](https://docs.nstbrowser.io/guide/fingerprint-browser/create.html) · [团队管理](https://docs.nstbrowser.io/guide/advanced/team.html) | 并发入场、任务取消、租约和 Worker 隔离在高压下保持一致。 |
| ego(lite) | Agent 在隔离的 Space 内操作，可用快照和批量脚本配合。[Space](https://www.egolite.ai/document/en/docs/windows/space) · [Skills](https://www.egolite.ai/document/en/docs/skills) | 单任务操作环境可定位，页面动作有紧凑批次和恢复记录。 |
| Browserbase | 会话可实时查看、回放和追踪动作。[可观测性](https://www.browserbase.com/observability) | 回放由 Agent 按需开启，按时间段查看，内存到期回收，Task 可关联经过脱敏的证据。 |
| Browserless | 提供会话重连、持久化和并发队列。[会话管理](https://docs.browserless.io/baas/session-management) · [队列](https://docs.browserless.io/enterprise/long-queues) | 抢占、超时、进程退出和重连可复查，繁忙主机按资源限制启动。 |

## 验收项

| 工作流 | 当前证据与待补项 |
| --- | --- |
| 安装、升级与恢复 | v0.1.20 曾出现主程序已换、后台和注册信息仍旧的中断状态，官方离线包已原位恢复。安装器加入锁文件回归。新版离线包在完成安装后写入版本记录，应用启动核验运行版本、登记和路径，再清除旧失败记录。Windows 原生单测覆盖了缺标记、登记不符和用更高版本修复。需完成真实候选包的失败、重试和会话保留验收。 |
| Agent 身份和审计 | 桌面设置已接入签发、轮换、撤销和凭据强制模式。本地 HTTP 与 WebSocket 测试覆盖管理权限隔离、密钥只返回一次、旧连接失效、撤销名称保留及批量任务权限。已签名 Windows 候选包的 WebView 验收会验证独立管理能力和诊断入口。 |
| 生命周期及规模 | 已有 Chromium、Firefox、WebKit 的产品通道，启动入场预算和 100 环境周转数据。需要同版本同负载复测、长时驻留和压力下清理。驻留与周转分别记账。参见 [批量启动验收](launch-performance.md)。 |
| 环境批量治理 | 已有环境分组、模板、回收站、导入预览和撤销。删除保护已接入本地工作区，界面批量移入回收站、MCP 删除、兼容 API 删除和永久清理均检查保护状态。需验收大批量操作及保存状态的恢复。 |
| 工作区恢复及迁移 | 已支持口令加密导出、恢复预览和原子提交。空白工作区测试恢复 703 个环境、两级文件夹、删除保护及回收站状态，使用实际 Chromium 和 Firefox 验证 Cookie 与本地存储。测试另覆盖损坏文件、错误口令、目录冲突和写入回滚。 |
| Agent 任务与回放 | 已有脚本、紧凑动作、验证检查点及限时内存回放。需要已安装版本验收多会话隔离、选择时间段、60 秒回收、关闭释放及中断后单次执行。 |
| Worker 运维与故障定位 | 已通过 HTTPS、加密状态交接和源端封锁验收。桌面设置可导出近期启动耗时、结果代码、队列状态和更新状态。异地宿主机的网络和密钥管理仍需用实际部署记录验证。 |
| 兼容与发布 | Vela 已执行 AdsPower V2 Selenium 合约验收。使用可用的真实对照产品运行同一测试页并记录版本和请求节流。发布 0.1.x 前核验 Windows、macOS、Linux 和 Android 安装包、桌面更新签名、下载摘要及升级验收。 |

2026-11-22 检查时，当前主机未监听 AdsPower 本地 API，仓库的自托管 Runner 数量为 0。驻留测试开始前记录可用内存，出现资源不足即停止并记录已实际验证的样本。对照产品性能和 30/60 环境的长时结果仍需独立记录。

## 工作区备份

在桌面设置的「数据与安全」中输入至少 12 字符的口令，再下载 `.vela-workspace` 文件。恢复前会显示环境、文件夹、会话、删除保护、回收站和冲突。存在同 ID 环境或原生目录时停止恢复。代理池节点依赖原工作区，恢复后需重新选择代理才能打开该环境。

备份包含环境配置、导入和待应用 Cookie、最近保存的浏览器会话、组层级及移交锁定信息。单个逻辑备份上限为 95 MiB。原生浏览器目录、扩展文件、脚本、代理池和 Agent 凭据各有独立生命周期。需要把 Native IndexedDB、站点缓存一起搬到另一台主机时，用环境移交中的原生状态选项。[Worker 环境移交](mcp-devtools.md)

```powershell
bun scripts/workspace-backup-acceptance.ts D:/VelaBrowser
```
