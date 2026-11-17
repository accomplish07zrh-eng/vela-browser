# 批量启动验收

Windows x64 上使用 Vela 固定的 Chromium 155 和 Firefox 156 内核，每轮以无头模式启动 8 个隔离的测试环境，并发上限为 4。耗时从整批提交算到本地 API 返回浏览器可用。冷启动使用新环境目录，重开使用同一批环境目录。

| 环境 | 口径 | 修改前 | 修改后 |
| --- | --- | ---: | ---: |
| Chromium | 整批冷启动 | 13.8 秒 | 9.9 秒 |
| Chromium | 整批重开 | 16.7 秒 | 13.6 秒 |
| Firefox | 冷启动首个可用 | 13.2 秒 | 5.8 秒 |
| Firefox | 整批冷启动 | 32.1 秒，7/8 成功 | 20.9 秒，8/8 成功 |
| Firefox | 整批重开 | 19.7 秒 | 12.3 秒 |

Firefox 在完成页目标初始化后交付控制权，恢复页面的资源可继续加载。首次批量启动先放行两个 Firefox 环境，首个环境可用后放开其余已排队的环境。MCP 桥接在首次使用时加载。验收为每个 Firefox 环境写入不同的会话 Cookie，重开后逐个验证。在另一次检查中，恢复标签页的图片仍在等待响应时，已可列出 MCP 工具和读取会话 Cookie。

Chromium 指纹采样复用本机 CDP，省去启动额外 Node 进程。Windows 将并发重开的 Cookie 密钥检查合入一次 DPAPI 调用。启动队列按可用内存和 CPU 调整并发，保留关闭和清理的调度容量。

## 复现

在安装固定依赖后执行以下命令。`--runtime-root` 指向已准备产品内核的目录，`--report` 可指定 JSON 输出路径。

```powershell
bun install --frozen-lockfile
bun scripts/launch-batch-acceptance.ts --runtime-root D:/VelaBrowser --engine chromium --profiles 8 --concurrency 4
bun scripts/launch-batch-acceptance.ts --runtime-root D:/VelaBrowser --engine firefox --profiles 8 --concurrency 4 --report reports/launch-batch-firefox.json
bun scripts/fingerprint-acceptance.ts --runtime-root D:/VelaBrowser
```

报告记录首个环境可用、整批耗时、最低可用内存以及各环境的启动阶段。本轮原生指纹基线为 43 项通过和 21 项失败。仍可复现 Chromium Shared Worker 和 Service Worker 字体差异、Firefox 跨上下文字体差异，以及当前 Windows WebKit Worker 缺少 OffscreenCanvas 等探针所需的能力。

## AdsPower V2

本地 API 扩展支持 `browser-profile/list`、`start`、`active` 和 `stop`。可使用环境 ID 或 Vela 显示的环境编号。V1、V2 和工作台调用共享生命周期队列。公开契约列出本轮支持的字段和响应格式。[Vela Local API](public/local-api.openapi.json) · [AdsPower V2 启动](https://localapi-doc-en.adspower.com/docs/Open-Browser-V2) · [AdsPower V2 环境列表](https://localapi-doc-en.adspower.com/docs/Query-Profile-V2)
