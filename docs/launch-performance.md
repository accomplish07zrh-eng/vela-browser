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

## 50 和 100 环境周转

同一台 Windows x64 主机完成了四组无头冷启动测试。每组最多运行 4 个环境。浏览器可用后，通过本地 API 关闭该环境，再启动队列中的下一项。四组均完成了全部启动和关闭。整批时间包含关闭和缓存清理，启动 P95 从 HTTP 请求发出算到 API 返回浏览器可用。

| 环境 | 启动成功 | 整批耗时 | 启动 P95 | 最低可用内存 |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 50 / 50 | 2 分 19 秒 | 8.5 秒 | 4.49 GiB |
| Chromium | 100 / 100 | 4 分 51 秒 | 11.8 秒 | 3.66 GiB |
| Firefox，字体调整前 | 50 / 50 | 5 分 32 秒 | 30.7 秒 | 3.00 GiB |
| Firefox，最终配置 | 100 / 100 | 6 分 43 秒 | 21.3 秒 | 3.50 GiB |

Firefox 调整字体加载前也完成了 100 个环境的周转，整批 9 分 40 秒，启动 P95 为 29.9 秒。两轮开始时的可用内存分别为 5.98 GiB 和 8.03 GiB。最终一轮的测试卷最低可用空间为 187.65 GiB。

工作台和环境列表共用并发设置。某个环境结束启动请求后，腾出的调度槽立即处理下一项。服务端继续按实时内存预算控制请求何时执行。

## 环境驻留

驻留测试在同一台 32 GiB Windows 主机上运行。每个环境从本地测试页收到不同的 Cookie。每轮采样验证全部环境。测试中间重开一个环境并检查相同的 Cookie。

| Chromium 环境数 | 启动成功 | 整批启动 | 启动请求 P95 | 驻留 |
| --- | ---: | ---: | ---: | --- |
| 4 | 4 / 4 | 9.84 秒 | 5.06 秒 | 30 秒，4 次采样均通过 |
| 30 | 30 / 30 | 96.95 秒 | 16.15 秒 | 约 47 秒，3 次采样均验证 30 个环境，可用内存降至 923 MiB 后结束 |

30 环境的早期一轮在驻留探测时遇到浏览器无响应。复测设定 60 秒，遵守 1.5 GiB 的主机内存余量。60 环境和 24 小时的持续性仍需验证。

## 复现

在安装固定依赖后执行以下命令。`--runtime-root` 指向已准备产品内核的目录，`--report` 可指定 JSON 输出路径。

```powershell
bun install --frozen-lockfile
bun scripts/launch-batch-acceptance.ts --runtime-root D:/VelaBrowser --engine chromium --profiles 8 --concurrency 4
bun scripts/launch-batch-acceptance.ts --runtime-root D:/VelaBrowser --engine firefox --profiles 8 --concurrency 4 --report reports/launch-batch-firefox.json
bun scripts/launch-batch-acceptance.ts --runtime-root D:/VelaBrowser --engine firefox --profiles 100 --concurrency 4 --fresh-only --close-after-ready --report reports/launch-batch-firefox-100.json
bun scripts/launch-batch-acceptance.ts --runtime-root D:/VelaBrowser --engine chromium --profiles 30 --concurrency 3 --fresh-only --soak-seconds 60 --sample-seconds 15 --report reports/launch-resident-chromium-30.json
bun scripts/fingerprint-acceptance.ts --runtime-root D:/VelaBrowser
```

报告记录首个环境可用、整批耗时、最低可用内存、测试卷可用空间以及各环境的启动阶段。

在有足够资源的测试主机上，用 `--profiles 60 --soak-seconds 86400` 运行 60 环境的 24 小时测试。`--adspower-url http://127.0.0.1:50325` 切换到本机 AdsPower V2，使用同一个测试页和驻留采样。AdsPower 轮次采用 1 秒请求间隔，报告记录此间隔和实际浏览器版本。启用了 AdsPower API 验证时可通过环境变量 `ADSPOWER_LOCAL_API_KEY` 提供密钥。脚本会关闭并批量删除本轮创建的测试环境。[AdsPower Local API 概览](https://localapi-doc-en.adspower.com/docs/Rdw7Iu)

Windows Firefox 环境会在启动时尽早加载 DirectWrite 字体别名。使用固定 Firefox 156 内核复测，两个环境中的窗口、同源与跨源 iframe 以及三类 Worker 均通过字体和文本度量一致性检查，每个环境重启两次后也保持一致。Firefox 共通过 22 项验收。

在同机的 Chrome for Testing 155.0.8059.84 和 Vela Chromium 155.0.8059.85 中，窗口、iframe 与 Dedicated Worker 能区分三种通用字体，Shared Worker 与 Service Worker 在同一测例中共用一种回退字体。Windows WebKit 的 Worker 仍缺少探针所需的 OffscreenCanvas。[Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)

## AdsPower V2

本地 API 支持 `browser-profile/create`、`update`、`list`、`start`、`active`、`stop` 和 `delete`。批量删除每次最多接收 100 个环境 ID。创建返回环境 ID 与 Vela 显示的编号。迁移时可以传入平台、备注、启动页、账号、Cookie、代理和支持的语言、时区、分辨率字段。更新导入的 Cookie 会在下次启动写入浏览器。V1、V2 和工作台共享生命周期队列。[Vela Local API](public/local-api.openapi.json) · [AdsPower V2 创建](https://localapi-doc-en.adspower.com/docs/New-Profile-V2) · [AdsPower V2 更新](https://localapi-doc-en.adspower.com/docs/Update-Profile-Info-V2) · [AdsPower V2 批量删除](https://localapi-doc-en.adspower.com/docs/Delete-Profile-V2)

受支持的 Chromium 首次调用 V2 `start` 时会下载并校验对应的 ChromeDriver。把返回的 `data.webdriver` 传给 Selenium 的 `Service`，把 `data.ws.selenium` 设为 `debugger_address`。Windows 上已用 Chromium 155 和 Selenium 4.36 验证迁移、自动下载、接管浏览器及关闭。装有 Python Selenium 的机器可运行 `bun scripts/adspower-v2-acceptance.ts --runtime-root D:/VelaBrowser` 复现。[AdsPower V2 启动](https://localapi-doc-en.adspower.com/docs/Open-Browser-V2) · [ChromeDriver 版本选择](https://developer.chrome.com/docs/chromedriver/downloads/version-selection)
