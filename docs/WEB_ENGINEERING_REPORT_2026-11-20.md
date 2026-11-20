# Us Web 跨引擎与换机验收报告

日期 **2026-11-20（北京时间）**。对象为工作区 `E:\双人小程序`、分支 `codex/web-two-person`、`e037767` 加当前工作树。本轮由接手 Agent 完成跨引擎回归、离线与换机用例的实现与修复，提交候选 ZIP、哈希和证据供独立审定。开发范围见 [Web 产品设计与开发计划书](US_WEB_DESIGN_AND_IMPLEMENTATION_PLAN.md)，部署与恢复步骤见 [Web 部署与恢复](WEB_DEPLOYMENT.md)。

## 1. 基线与交付物

| 项目 | 结果 |
| --- | --- |
| 候选包 | `artifacts/web-release/us-web-1.2.11-2026-11-19T16-44-29-299Z.zip` |
| 大小 | 858,152 字节 |
| SHA-256 | `f173b8d22561de9ca326036e06fb3a2e9d2c886614ef2e1ec0a3c73ec84ad362` |
| 源码检查 | `npm run check:web` 成功：Web 类型检查、16 个 Vitest 文件 113 项测试、Vite 生产构建；记录在 `artifacts/tests-report.json` |
| 包内核对 | e2e 夹具按 `manifest.json` 逐文件校验 SHA-256，并核对 Vite 清单与包内 JS/CSS 完全一致 |
| 工作树 | `git diff --check` 退出码 0。未提交改动与新增文件均保留，未执行重置、清理或提交 |

本轮验收使用的是由当前源码构建的同一份候选包；发布包由 `scripts/package-web.mjs` 生成，`server.mjs` 从 `src/server/web-entry.ts` 现场打包。

## 2. 本轮改动清单

建议评审顺序：先 `web/cipherCache.ts`（唯一产品代码改动），再 `e2e/tls-fixture.ts`，最后两份 e2e 用例。

| 路径 | 关联 | 改动 | 原因 | 回退 |
| --- | --- | --- | --- | --- |
| `web/cipherCache.ts` | W15、W16、W17、E12 | 密文快照和照片密文改为以 **JSON 文本**写入 IndexedDB；读取同时兼容旧版本的 `Blob`；容量核算按 UTF-8 字节数 | WebKit 26.4 的 IndexedDB 写入 `Blob` 会中止事务，缓存一直为空，WebKit 断网重开必然提示「没有仍在有效期内的本机缓存」 | 单文件回退。旧版本写下的 `Blob` 仍可读取；新版本写下的文本需同时回退代码才能被旧版本读取，否则重新联机即可重建 |
| `e2e/tls-fixture.ts` | W02、W14、E12 | 新增 `setNetworkAvailable(value)`，断开时直接销毁入站连接，模拟真实断网 | Playwright 的引擎级离线不作用于 Service Worker 会话，见第 3 节 | 只影响测试夹具 |
| `e2e/hosted-web.e2e.ts` | E07、E12、W17 | 离线段落同时切断上游连接与引擎离线；恢复时先恢复上游再触发 `online`；照片缓存配额夹具改用文本载荷并兼容两种载荷 | 原来仅靠引擎离线，打包 Chromium 会从服务器拿到在线页面，离线断言不成立 | 只影响测试 |
| `e2e/web-compat.e2e.ts` | W02、W07、W14、W17、E03、E05、E12 | 补齐错误恢复密钥、他人备份、撤销设备、撤销后重新登记、恢复后写回、记住解锁刷新与取消记忆、主动锁定、跨标签、仅共同授权设备；按引擎选择断网方式；区分引擎网络噪声 | 交接文档任务 A 要求的两类换机与离线证据原先只覆盖到部分步骤，且 WebKit 在引擎离线时导航报内部错误 | 只影响测试 |

## 3. 定位与判断

### 3.1 WebKit 断网重开失败是产品缺陷

先在 WebKit 复现：断网重开能出现离线壳层，但输入本机口令后提示「没有仍在有效期内的本机缓存」。检查 IndexedDB 发现 `us-web-cipher/snapshots` 为空，同一次测试中开关已写入 `us.web.<account>.cipherCache=true`。用最小探针逐项写入 IndexedDB：

| 载荷 | 结果 |
| --- | --- |
| `Blob` | `error`（事务中止，`error` 为空） |
| `ArrayBuffer` | 成功 |
| 字符串 | 成功 |
| 非可导出 AES-GCM `CryptoKey` | 成功 |
| 复合 keyPath | 成功 |

结论：该 WebKit 版本无法在 IndexedDB 持久化 `Blob`，而 `cipherCache` 的快照与照片都以 `Blob` 存储，写入异常又被 `service.ts` 的 `try/catch` 记为「无法保存…缓存」警告，界面不阻断，于是缓存始终为空。改为 JSON 文本并按 UTF-8 字节数核算容量后，WebKit 断网重开、缓存照片读取与 16 MiB 淘汰逻辑均通过；记住解锁所需的 `CryptoKey` 存储不受影响。

照片密文一次约 0.7 KB 到数十 KB，字符串与 `Blob` 的体积差仅为 JSON 转义量，容量上限与淘汰顺序保持不变。

### 3.2 打包 Chromium 的离线断言原本不成立

`npm exec playwright test e2e/hosted-web.e2e.ts` 在打包 Chromium（148，headless）首次运行即在「断网刷新」处超时，页面显示的是在线登录页而非离线壳层。Playwright 的 `BrowserContext.setOffline` 通过 `Network.emulateNetworkConditions` 下发，而 `playwright-core` 的 `_setOfflineForSession` 对 `workerFrame` 直接返回，**Service Worker 的网络请求不受该离线模拟影响**：断网时 SW 的 `fetch(request)` 仍然成功，于是返回在线页面而不是缓存壳层。真实设备断网时 SW 请求同样失败，产品路径本身正确。

修复落在测试夹具：断开时销毁 TLS 前端的上游转发，让页面与 SW 的请求都真实失败。Edge 157 在旧的「仅引擎离线」写法下曾经通过，说明该结果依赖引擎版本或首个导航的时序；改为真实断网后打包 Chromium 与 Edge 都稳定通过。

WebKit 另有差异：在 `setOffline(true)` 下刷新由 Service Worker 响应的导航会抛 `WebKit encountered an internal error`；只切断真实上游时，`reload` 与 `goto` 都能正常命中离线壳层。因此 WebKit 配置只使用真实断网，Chromium/Firefox 两者并用，以便同时验证 `online` 事件触发的自动重连。

### 3.3 引擎噪声与产品错误的区分

WebKit 会把「导航离开时被取消的 `/api/space` 请求」作为页面错误上报（`Fetch API cannot load … due to access control checks.`），而应用对该 Promise 已有 catch。用例把这类消息单独计数（多次运行 2–4 条，实测值写入 `browser-compat.json` 的 `engineNetworkNoise`），其余页面错误仍然判失败。Firefox 未出现同类噪声。

## 4. 测试证据

| 项 | 命令或路径 | 环境 | 结果 |
| --- | --- | --- | --- |
| 源码检查 | `npm run check:web` | Windows，Node.js 24.13.0 | 通过；113 项测试，生产构建成功 |
| 主链路与上线冒烟 | `playwright test e2e/hosted-web.e2e.ts e2e/web-origin.e2e.ts` | 打包 Chromium 148，Windows | 2 项通过 |
| 主链路（已安装浏览器） | 同上，`US_WEB_BROWSER_CHANNEL=msedge` | Microsoft Edge 157.0.4341.60 | 1 项通过 |
| 跨引擎 | `playwright test e2e/web-compat.e2e.ts` | Firefox 150.0.2 + WebKit 26.4，Windows | 通过，约 1.3 分钟 |
| 跨引擎报告 | `artifacts/playwright-web-compat/…/browser-compat.json` | 同上 | 引擎版本与 18 项断言标记；`engineNetworkNoise` 记录引擎噪声条数 |
| 同步与规模样本 | `artifacts/playwright-web-release/…/web-workload.json` | 打包 Chromium 148，360×800，75 ms 延迟、9 Mbit/s 下行 | 1,000 条历史：首页可操作 592 ms，筛出千条首屏 827 ms；手动刷新 P95 209 ms；两端各 10 次合成图文写入，同步 88–224 ms、照片 186–328 ms；银河 50／300／1,000 张就绪 128／145／87 ms |
| 依赖审计 | `npm audit --audit-level=high --registry=https://registry.npmjs.org` | 公开注册表，2026-11-20 | 0 条已知漏洞。本机默认镜像未实现审计端点，需显式指定公开注册表 |
| 逐文件哈希 | e2e 夹具 `stageRelease` | 候选 ZIP | 通过 |

跨引擎用例实际断言的范围：

- 配对与安全码核对、错误安全码未交换密钥。
- 共同与私人图文双向读回；私人记录对另一成员不可见。
- 空 MIME、横竖照片、带方向 6 与合成 GPS 的 JPEG、透明 PNG；显示尺寸为源图的 96×高，输出 JPEG 字节不再含 `Exif\0\0`，PNG 右侧像素仍为透明。
- 留言归属与按成员收藏同步。
- WebKit 冷启动离线：断网重开、输入本机口令、读取缓存图文与已缓存照片，私人记录不出现。
- WebKit 中直接核对 IndexedDB 快照载荷为文本（`[object String]`），防止回退成 WebKit 无法保存的 `Blob`。
- 错误恢复密钥、「他人备份」分别拒绝，且不写入本机密钥库。
- 两位成员互换浏览器恢复后各自能解密私人图文，共同图文双向可读。
- 恢复后的新设备写入共同图文，对端在另一引擎读回并解密照片。
- 记住解锁后完整刷新可解密；取消记住解锁后刷新需重新输入口令；主动锁定后刷新需重新输入口令；跨标签同步锁定并能用口令重新打开。
- 撤销恢复出的设备后，被撤销设备被要求重新登记、不再显示记录；用本人加密备份可重新登记并读回旧内容。
- 仅共同授权设备：登记、由成员另一方发送空间密钥、只能看到共同记录、私人选项禁用、写入的共同日记对端可读。

主链路用例（Chromium/Edge）继续覆盖配对、回执丢失、幂等保存、私人隔离、本机密文缓存、离线队列与跨标签锁、照片配额淘汰、PWA 更新、归档导出、并发编辑、站内陪伴、选餐、衣橱、银河、纪念册 PDF、外部地图与 AI 边界、问答、记住解锁、仅共同设备入口与浏览器存储不可用提示。跨引擎用例未重复银河与纪念册，这些仍只有桌面 Chromium 证据。

## 5. 覆盖范围与未完成项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| E01 配对 | 已通过（Chromium、Edge、Firefox+WebKit） | 真机未测 |
| E02 共享图文 | 已通过（同上） | 真机未测 |
| E03 隔离 | 已通过（同上） | 真机未测 |
| E04 锁定与会话 | 已通过（Chromium、Edge、Firefox+WebKit） | 手机后台与长期到期未测 |
| E05 两类换机 | 桌面跨引擎通过（含撤销、仅共同授权） | 真机与真实恢复包样本未测 |
| E06–E08 并发、回执、照片 | Chromium/Edge 通过 | 真机弱网与 iPhone 选图未测 |
| E09–E10 生命周期、恢复 | 单元与脚本证据 | 目标主机、异机快照恢复演练未做 |
| E11 可访问性 | 360 px 宽度在跨引擎用例中覆盖；键盘、减少动效与打印在 Chromium/Edge 用例覆盖 | 屏幕键盘与真实触摸未测 |
| E12 离线与更新 | Chromium 完整通过；WebKit 冷启动离线通过 | 真机安装、存储回收与多图弱网未测 |
| E13–E14 陪伴、银河、纪念册 | Chromium/Edge 通过 | 真机与打印实测未测 |
| E15 外部处理 | Chromium/Edge 通过（默认关闭、取消无请求、仅预览坐标） | 真实地图服务可达性未测 |

等待外部条件、本轮无法完成的项目：

1. 正式或预发布 HTTPS 域名、主机接入、持久卷与证书链；`scripts/check-web-origin.mjs` 尚未对真实源运行。
2. 两部实际日用设备（iOS Safari、Android Chrome）的 E01–E11 与 PWA 安装、断网重开。
3. 独立主机上的快照备份与灾备演练（RPO 24 小时、RTO 4 小时），以及目标主机上的 25% 空间告警与 10% 新照片拒写边界。
4. 远端 CI 首次运行（`.github/workflows/web.yml` 已配置三引擎），以及 Ubuntu 上的 Firefox/WebKit 复核。
5. 真实 iOS Safari 与真实地图、AI 服务商的放行评审。

## 6. 风险与回退

- **缓存格式变更**：新版本写文本、旧版本写 `Blob`；读取两者兼容。若必须回退到旧版本，建议先在「我的」关闭并重新开启本机密文缓存以重建，旧包读取文本载荷会失败。未改变加密格式、服务器 schema 或记录协议。
- **离线受真实断网影响**：Chromium/Firefox 同时启用引擎离线与真实断网，WebKit 只用真实断网（引擎离线会让 Worker 缓存的导航报内部错误）。若将来需要验证 WebKit 的 `navigator.onLine` 分支，需另行覆盖。
- **引擎噪声过滤**：只过滤 WebKit 取消请求的固定文案，并写入报告计数；其他页面错误仍阻断。
- **发布包回退**：保留旧发布目录与原数据库副本，按部署手册执行；本轮未修改数据库 schema。

## 7. 变更评审要点

- **双人账号与身份**：未改动账号、邀请码、会话或身份格式；恢复仍按 `bootstrap` 返回的账号和空间核对身份，跨账号备份继续拒绝。
- **设备授权**：新增用例核对撤销后旧设备被锁定、不再显示记录，以及用本人备份重新登记后可读回旧内容；仅共同授权设备无法声称私人权限，私人选项在界面禁用。
- **密钥轮换**：本轮未改轮换、传输与恢复信封代码；缓存只保存密文快照与照片密文，不含任何空间密钥或恢复密钥。
- **加密与撤回**：缓存内容在写入前已加密，离线下仍需本机口令解锁后才能读取；主动锁定、取消记忆和退出都会清除或失效解锁记忆；私人记录的隔离断言保持。
- **数据兼容**：缓存载荷由 `Blob` 改为文本，读取同时兼容两种形态；未改数据库 schema、记录协议或归档格式。
- **回退**：只回退 `web/cipherCache.ts` 即可恢复旧行为；如旧版本需读取新缓存，先关闭并重新开启本机密文缓存以重建。

## 8. 结论

候选包通过源码检查、打包 Chromium 与 Edge 的主链路回归、Firefox 与 WebKit 的跨引擎回归，以及从同一候选 ZIP 解包的逐文件哈希核对。跨引擎的离线冷启动、两类换机、撤销与仅共同授权设备已有桌面证据。按计划书第 14 节，**可进入隔离预发布**；正式发布仍需目标 HTTPS 环境、两部真机、异机恢复演练和评审签字。
