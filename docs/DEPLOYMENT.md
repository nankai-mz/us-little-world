# 微信与云开发部署

## 配置

需要小程序 AppID、该 AppID 可访问的 CloudBase 环境和两名微信体验成员。浏览器本机模式不需要这些信息。不要把 AppSecret 或 AI 密钥放进小程序代码。

1. 使用 Node.js ≥22.12.0 和 PowerShell 7，安装根工程与云函数锁定依赖。
2. 用下方工具填写公开标识；未获得标识时可以跳过，完成本地候选构建。
3. 运行 `npm run release`，用微信开发者工具导入根目录。
4. 选择支持 BigInt、`wx.getRandomValues` 和云开发的基础库；项目标记为 3.10.3，仍需按届时工具可用的版本在真实手机验证。

```powershell
npm ci --registry=https://registry.npmjs.org
npm ci --prefix cloudfunctions/usApi --ignore-scripts --registry=https://registry.npmjs.org
npm run configure -- --appid wx0123456789abcdef --env 你的真实环境ID
npm run release
```

也可以复制 `config/deployment.example.json` 为 `config/deployment.local.json`，填写 `appid`、`cloudEnv` 和可选 `cloudFunction`（默认 `usApi`），然后运行：

```powershell
npm run configure -- --file config/deployment.local.json
```

工具只接受这三个公开字段，校验后更新 `project.config.json` 和 `miniprogram/config.ts`，保留其他项目设置。它不会登录、创建环境、上传或部署；`*.local.json` 不进入工程分享包。若改变函数名，需同时调整云端函数目录 / 部署名称，通常保留默认值即可。任何密钥都不能填入该文件。

`npm run preflight` 检查版本、构建与测试证据、离线 SDK 检查、依赖审计和权限模板。报告将 `localBuildReady` 与 `configurationComplete` 分开：本地准备可在配置缺失时通过；`npm run preflight -- --require-cloud-config` 额外检查配置是否填写（缺失时退出码 2）。配置齐全只证明格式正确，不证明账号可访问环境。

## 开发/生产双环境（可选）

如果同一个微信账号既要开发测试空间、又要保留正式空间，需要把两种版本指向两个不同的 CloudBase 环境。同一个微信 OPENID 在两个环境各有一份 `users` 记录，因此可以各有一个空间；同一个环境内仍限制一个活跃空间。

1. 在云开发控制台新建一个测试环境（例如 `us-dev`），不要与正式环境共用数据库。
2. 写入公开标识：

   ```powershell
   npm run configure -- --appid wx0123456789abcdef --env 正式环境ID --dev-env 测试环境ID
   ```

   也可以把 `devCloudEnv` 写进 `config/deployment.local.json` 后用 `--file`。不要填入任何密钥。
3. 客户端按运行版本自动选择环境：`release` 使用 `cloudEnv`，`develop` / `trial` 使用 `devCloudEnv`；`devCloudEnv` 为空时回落到正式环境。选择逻辑在 `src/core/env.ts`，不要在页面里硬编码环境 ID。
4. 测试环境需要单独完成与正式环境相同的部署：9 个集合、索引、拒绝客户端访问的规则、私有存储规则、`usApi` 云函数；需要 AI 和维护定时器时也分别配置。
5. 开发版/体验版用测试环境创建测试空间，正式版用正式环境创建正式空间。不要用开发版写入正式环境数据。

项目只声明主动 `chooseLocation`，没有声明或调用后台定位。发布前在微信公众平台按实际用到的照片和地图接口完善「用户隐私保护指引」及接口使用权限；代码在用户点选照片 / 地图时调用微信隐私授权接口，不在启动时索取位置权限。若账号类目不允许地图选点，保留文字地点与手动坐标功能。

## 数据库与权限

使用经典文档数据库，不是 CloudBase PostgreSQL 模式。按 `database/collections.json` 手动创建以下集合：

```text
users  spaces  devices  invitations
key_envelopes  encrypted_records  encrypted_files  ai_limits  maintenance_state
```

为每个集合设置 `database/deny-client.rules.json` 的规则，云存储也设置相同的「普通客户端不可读写」规则：

```json
{ "read": false, "write": false }
```

这些规则不阻止具备服务端权限的云函数，所有应用访问统一经过 `usApi`。相关官方行为见 [CloudBase 规则说明](https://docs.cloudbase.net/en/rule/rule-example) 和 [存储规则](https://docs.cloudbase.net/storage/security-rules)。不要将云存储配置成公开可读。

列表查询按 `_id` 稳定分页。按 `collections.json` 中字段顺序建立所有索引，包括密钥包的当前版本查询及按空间清理文件、邀请和配额的查询；以控制台实际提示为准。

## 云函数

- 代码目录：`cloudfunctions/usApi`，入口：`index.main`。本候选依赖要求 Node.js ≥20.19.0；部署时必须在控制台确认实际可选运行时满足该要求，不能仅凭「Node 20」名称判断。
- 运行 `npm run build:cloud` 后，在微信开发者工具右击该目录，选择上传并部署（云端安装依赖）。
- 设置适当的函数超时（AI 调用会在 25 秒超时）与内存。图片通过函数转存且限小图，应实际验证平台请求 / 响应大小上限；不要擅自放大文件限制。
- SDK 使用 `throwOnNotFound: false`，第一次访问不存在的用户 / 记录会得到 null；数据库集合本身仍需先创建。
- 当前候选锁定官方 **`wx-server-sdk 5.0.1-beta.1` 预发布版**，并用 npm `overrides` 固定 `axios 0.34.0`。本地 SDK 检查用替身驱动验证包装层，不向腾讯发请求；尚未验证真实数据库事务、文件服务和 OpenID。先在测试环境逐项验收，不应直接上传为生产版本；部署后需确认安装的依赖遵循锁文件及 override，并重新审计。
- SDK 版本与 override 的改动都应重跑完整流程。若改回旧 SDK，应重新评估其依赖告警，不沿用本候选报告。

AI 可选环境变量（仅保存在云函数配置）：

| 环境变量      | 含义                                                                            |
| ------------- | ------------------------------------------------------------------------------- |
| `AI_BASE_URL` | HTTPS 的兼容服务基础地址，例如服务商提供的 `/v1` 地址，不带 `/chat/completions` |
| `AI_API_KEY`  | 模型服务密钥，不写入仓库                                                        |
| `AI_MODEL`    | 服务商实际可用的模型标识                                                        |

适配器使用兼容 `chat/completions` 的 HTTP 请求格式。未经真实服务测试不代表已完成 AI 验收；未配置时会返回 `AI_NOT_CONFIGURED`。服务端固定 `story` 任务、6000 字符单位输入、1600 tokens 输出；需两位成员，默认每空间每日 10 次、全局每日 100 次，按服务器上海日期计算。失败或未知计费结果仍占用配额。尚未启用微信订阅消息。

## 1.2.1 维护定时器（必须单独配置和验收）

本版 API 协议为 2。请同时更新客户端和 `usApi`，旧客户端不能执行新语义的关闭、AI 或接收确认操作。数据加密封装无需迁移。

1. 创建并拒绝客户端访问 `maintenance_state`，补齐上方索引。
2. 在云函数环境中设置 `MAINTENANCE_TOKEN`：自行生成至少 32 字符的随机秘密，不写入小程序、源码、日志或本地公开配置，不发送到聊天中。
3. 在控制台给 `usApi` 创建名为 **`usMaintenance`** 的定时触发器，例如每小时运行。向其自定义 `Message` 配置 JSON 字符串，结构为 `{"maintenanceToken":"你的随机秘密"}`，与环境变量一致。不要把真实值提交进仓库。定时事件结构及 Message 支持参见 [腾讯云定时触发器说明](https://cloud.tencent.cn/document/product/583/9708)；应在实际 CloudBase 环境确认字段一致，不要放宽鉴权条件。
4. 维护入口只接受该定时事件、无 OPENID 的服务端调用及正确秘密；普通小程序调用即使伪造事件字段也会被拒绝。不要开放公共 HTTP 入口。
5. 在隔离测试环境验证过期空间清理、文件删除失败重试、分批续接、过期邀请 / 密钥包 / 限流清理，以及新空间绑定不受影响。默认每次最多删除 100 项，积压需要多次执行；检查失败和实际清理进度，不能把设置了定时器当作删除完成。
6. 没有双方删除确认的旧 `closed` 数据会标记为 `cleanupBlocked`，不会自动删除或重新开放。先核对归属及删除授权，再安排迁移。

未配置秘密或触发器时，不会执行自动清理；本次没有创建任何定时器。临时文件和浏览器本机数据另按本机规则管理。

## 双人首次进入

1. A 创建空间、设置本机解锁口令，离线保存恢复密钥；从「备份与恢复」导出加密密钥备份。
2. A 到「设备与安全」生成一小时有效的一次性邀请码；通过可信渠道给 B。
3. B 使用另一微信账号加入，设置自己的本机口令和备份。此时没有空间解密密钥。
4. 双方在可信渠道核对对方设备安全码。安全码同时绑定签名与加密公钥，不要只核对一把公钥。
5. A 输入 B 安全码，对 B 设备发送加密密钥；B 输入 A 安全码，点击验证来源并接收。
6. 两人刷新记录列表；分别重新导出更新后的加密密钥备份。恢复包属于原微信账号，不能替别人恢复。

## 运维行为

「我的 → 连接与同步」的连接检查调用 `health`，只返回应用版本、协议、服务时间和配置状态，不读取记录正文或照片。检查成功仅代表接口可连接；点击取得最新记录才会另行读取有权限的密文。客户端对只读请求最多自动重试一次；保存、删除、AI 等操作不会自动重发。若网络中断导致结果不确定，先刷新确认后再决定是否提交。

发布前应人工记录 `docs/ACCEPTANCE.md` 的实际结果。自动报告中的 CloudBase、iOS、Android、AI 均标为 `not_recorded`，本地检查不会将这些项目标为已验收。

撤销设备后，对仍受信任的设备执行密钥轮换。对方应接收新版本再写入共同内容；旧密钥保留用于历史读取。不要把「设备撤销」误认为撤回此前的副本。

记录删除先进入回收站。作者可以二次确认永久删除自己的回收站记录；本人上传的照片密文随之清理。关闭双人空间须双方确认；七天冷静期可读、可导出、可撤销，之后交由已鉴权的维护任务清理。建立新空间后不能通过撤销关闭覆盖新绑定。详情见 `PHASE121.md`。

1.2.1 本地候选构建阶段未使用真实云服务。2026-11-03 已按后台核实信息配置 AppID 与用户扫码开通的环境；本轮尚未部署集合、规则、函数、存储或维护定时器，也未提交代码审核。当前进度见 `WECHAT-SUBMISSION-20261103.md`，不能将配置完成当作云端验收通过。
