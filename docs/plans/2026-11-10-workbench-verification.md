# 多视口工作台验证记录

2026-11-10 · 台北时间。此记录对应最终画廊版，替代早期 6px 圆角 / 水印 / 默认巡航的描述。

## 当前行为

- 卡片 12px 圆角、16px 间距、16:10 画面、32px 底栏；名称与状态不覆盖网页。
- 一个环境一张 DOM 卡片，offset 取模形成无头尾的错缝环，不靠克隆节点补边。自动选一至三行；周长不足则降行或普通网格。
- 滚轮、拖动、键盘、左右按钮、指示器和用户开启的巡航共用 offset。弹簧惯性、预测吸附、48px 边缘渐隐；减少动态时禁用巡航 / 视差。
- 搜索定位、分组同步、快速切组、全览、多选、批量编辑、聚焦、显式群控及一键停止。
- 预览 width-fit；聚焦 contain 显示完整真实画面并准确映射留白坐标，不改浏览器实际视口或身份。
- 转动时冻结采帧且拒收迟到帧。隐藏环境停止采集，显式跟随仍能接收输入，停稳后恢复画面。
- 68px 图标侧栏，完整收展和途中双向反转；窄于 760px 强制图标栏。
- 纸张明暗主题、本地字体、单色图标、低饱和状态、Ctrl+K 工作区索引；管理页去旧外框、胶囊筛选和鲜绿状态条。

## 自动检查

| 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| 工作台、布局、界面、翻译、Windows 打包相关测试 | 103 通过、0 失败，4245 次断言 | `reports/gallery-regression.log` |
| TypeScript | 通过 | `reports/gallery-typecheck.log` |
| 前端生产资源构建 | 通过 | `reports/gallery-build.log` |
| sidecar 编译及 Tauri 调试构建 | 通过，未打安装包 | `reports/gallery-sidecar-build.log`、`reports/gallery-desktop-build.log` |
| Git 差异空白检查 | 通过 | `reports/gallery-diff-check.log` |

命令：

```powershell
bun test workbench.test.ts web/workbench-layout.test.ts dashboard-ui.test.ts web/i18n.test.ts scripts/prepare-windows-bundle.test.ts
bun node_modules/typescript/bin/tsc --noEmit
bun build web/index.html --outdir reports/gallery-build
bun node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle --config reports/workbench-tauri.json
git diff --check
```

布局测试覆盖 1–40 个环境、不同宽高、各排数量不同、正反跨圈和接缝间距，包含低帧率下按真实时间推进弹簧、聚焦留白输入坐标及不同尺寸的群控映射。

此前完整测试记录是 2020 通过、30 跳过、8 失败。其中六项在原基线也可复现，涉及健康快照、认证跳转、文档哈希和安装器 URL；两项 Python 下载在完整运行中失败、在基线单跑通过。本次没有把完整测试集标为全绿。

## 12 环境真实浏览器验收

使用一次性独立目录和本地 QA 页面，不操作用户账户。Tabbit 仅控制自建测试页；该测试页启用只提供工作台能力的临时 bridge，产品代码无测试 bridge。12 个 Chromium 浏览器各自拥有独立持久化目录。

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 12 个唯一 DOM 卡片、向右七步、向左七步、回到原位、滚轮与拖动吸附、搜索定位 | 20 项通过 | `reports/gallery-navigation-state.json` |
| 顶部分组、侧栏分组同步、快速切组、全览、Ctrl 多选、弹窗焦点限制 | 6 项通过 | `reports/gallery-navigation-rest.json` |
| 中文输入和点击独立、聚焦前后尺寸不变、主控 + 11 跟随含屏外、停止同步、Cookie / localStorage 独立、Esc、移动冻结与恢复 | 10 项通过 | `reports/gallery-isolation.json` |
| 全局搜索定位与选组、快速切组、减少动态、700×560 窄窗、暖深色、当前页面无 JS 错误 | 7 项通过 | `reports/gallery-appearance-final.json` |

较早的快速切组曾暴露跳过 View Transition 时未处理的 AbortError。已处理 ready 和 finished 的拒绝；最终外观复测的当前页面错误数组为空。历史 receipt 的旧 origin 警告保留，不将其算作新页面错误。

隔离验证在测试页实际读到 `account=1…12` 的 Cookie 和 localStorage。普通输入只进入选中环境；明确开启群控才同步，停止后跟随不再接收后续输入。记录包含 240 次 frame 观察；持有拖动 1.5 秒期间没有迟到帧，停稳后恢复。

上述采帧频率是分级目标，未进行完整 CPU / 内存 / 长时间高负载基准测试。

## 原生桌面验收

独立 QA 应用标识、D 盘测试数据目录，通过真实 Launcher 启动 Vela Chromium 与 Vela Firefox，使用真实 Tauri 工作台能力，无测试 bridge。

- 两内核均收到真实画面；聚焦 object-fit 为 contain；真实标签页新建、激活、关闭和 Esc 归位通过。
- Ctrl+K 原生键盘入口通过；页面错误数组为空，见 `reports/gallery-native.json`。
- 侧栏从 248px 收至 68px；收起中反转回 248px、展开中反转回 68px 均通过。采样包含实际中间宽度，见 `reports/gallery-native-sidebar.json`。
- 配置列表、代理、设置均已截图复查，标题实际为本地衬线字体 24px；见 `reports/gallery-management.json`。

先前原生输入专项另见 `reports/native-workbench-interaction.json`，覆盖文本 / 中文合成 / 粘贴事件、点击、拖动、滚动、两环境隔离和离开工作台不关闭浏览器。此次最终版新增验收没有用该历史结果替代当前的两内核标签与侧栏复查。

## 视觉证据与边界

- `reports/gallery-light.png`、`reports/gallery-dark.png`：12 个真实隔离浏览器，画面为本地验收网页。
- `reports/gallery-index.png`：Ctrl+K 工作区索引。
- `reports/gallery-native.png`、`reports/gallery-native-rail.png`：原生桌面工作台与图标侧栏。
- `reports/gallery-management.png`、`reports/gallery-proxies.png`、`reports/gallery-settings.png`：管理页面复查。

视觉复查已收掉旧的大圆角外框、胶囊导航 / 筛选、Logo 扫光、鲜绿运行标记，修正选中图标 / 头像对比度和版本号重叠。未把全部管理交互重做，待补范围见 `2026-11-10-gallery-design.md`。

真实外部代理出口、第三方账户和商业指纹产品对比不在本次测试中。指纹三内核专项仍为 44 通过、20 失败，详见 `2026-11-10-fingerprint-parity.md`；视觉与工作台验收不能替代它。

验收进程和测试页在收尾关闭，保留本地预览与报告。未提交、推送、安装或发布。
