# CloudDrive2 接入试点（普通传输已试验，分享导入未支持）

## 普通上传／下载路径：2026-10-03 实测

不必先实现分享转存。网页上传 276 字节合成文本、API 上传另一份 276 字节文本，以及 API 分 16 块上传 4 MiB 随机样本均已实测。目录强制刷新后文件大小、SHA-1 匹配；3090 通过自己的 CD2 回环接口下载，完整 SHA-256 和两段 HTTP 206 拼接均一致。专用目录普通 API 读写已验证，**不代表正式门户已接入、几十 GB 吞吐、断网续传、跨机导入或排除 CD2 缓存的云端冷读已验收**。

- 用户明确确认后，仅给既有目录受限令牌补充“创建文件／写入”；根目录、读取范围、删除和系统权限未扩大，保存并重开界面核验。此前 `CreateFile` 的 code 7 已消除，`CreateFile → WriteToFile → CloseFile` 和读回校验均通过。普通成员仍不能获得此令牌。
- `GetDownloadUrlPath(get_direct_url:true)` 本次没有 `directUrl`，仅有 CD2 `/static/` 路径；HEAD 返回 200 而非 302，文件字节经 CD2。试点云连接的“支持直链”原为关闭；尝试保存启用时，CD2 明确提示当前计划不允许，已取消未保存的修改，未购买套餐。阿里云盘会员与 CD2 自己的功能权限不是同一项。不能据此宣称阿里 Open 永久不支持直链。
- 官方普通上传 RPC 是 `CreateFile → WriteToFile / WriteToFileStream → CloseFile`；写入／关闭成功不等于后台云上传完成。需核对上传完成状态、强制刷新和哈希，且核算本地临时空间。官方 `RemoteUpload` 协议也把文件字节发送给 CD2，并非给客户端签发阿里云原生上传 URL。
- 可行的候选数据路径为：客户端直接到实验室上传入口 → 3090/CD2 → 云盘；取回时由 3090/CD2 拉取并通过实验室 LAN 按需分发。门户只负责授权和任务状态；若仍让 VPS 代理上传请求，文件字节仍会消耗 VPS 带宽。校外能否绕过 VPS，取决于实验室是否有真实可达的数据入口，CD2 本身不解决这一问题。

试验未暴露 CD2 管理端口、未扩大令牌目录作用域、未修改生产门户或媒体库。正式分享适配器仍关闭；普通上传应为独立、用户任务绑定的后台能力，不直接把 CD2 令牌或文件浏览器开放给成员。试点专用目录保留三份合成样本（两份 276 字节、一份 4 MiB），不含用户数据。

## 2026-10-03 真实试点结论

在 1.1.1 的已登录阿里云盘 Open 连接中，创建目录受限的专用 API 令牌后，目录元数据读取成功，但 `canAddShareLink=false`。对用户批准的测试分享执行一次 `AddSharedLink`，服务返回 gRPC `UNIMPLEMENTED`（code 12）：`add_shared_link is not supported for 阿里云盘Open`。因此“成员提交阿里分享链接 → 自动转存 → 直链下载”的流程在本试点不可用；正式适配器保持关闭，不通过扩大权限、文件中转或自动切换后台掩盖此结果。

另一个实机兼容边界：目录受限令牌把授权目录映射为 API 的 `/`。发送真实云盘绝对路径会被再次拼到令牌根目录下，`CloudAPI.path` 也可能缺失。目前适配器的绝对路径/身份校验尚未适配该作用域模型；不能直接照抄下方配置示例上线。上述普通 CD2 文件流校验不能当作云盘直链验收。

本适配器仅是一个可测试、默认关闭的后台实现。3090 单机试点的 CloudDrive2 登录、Aliyun Open `canAddShareLink` 能力、分享转入和云盘直链均须另行验收；本机单元测试和 gRPC 测试不能证明这些真实能力可用。本文不授权新建其他实例、修改网络、开启 FUSE 或把管理端口公开。

## 官方协议与边界

协议依据为官方 [v1.1.1 protobuf](https://www.clouddrive2.com/api/clouddrive.proto) 和 [gRPC 开发者指南](https://www.clouddrive2.com/api/CloudDrive2_gRPC_API_Guide.html)，核对日期 2026-10-03。`proto/clouddrive-pilot.proto` 仅包含所用 RPC 的线兼容字段子集；没有文件字节读取、删除、挂载、账号遍历或系统配置 RPC。运行时使用固定版本 `@grpc/grpc-js` 和 `@grpc/proto-loader`，不是猜测 REST 或手写 gRPC-Web。

- `FindFileByPath` 读取专用 intake 或经签名回执指定的文件。检查 `CloudAPI.name/userName/path`、云盘对象类型、精确完整路径和权限。
- `canAddShareLink` 必须由真实 intake 目录返回 `true`；不存在或 `false` 立即停止，不能据此推断 Aliyun Open 支持分享。
- 每次 `list({shareId,password})` 先在**管理员批准的专用 intake**内创建随机 `gpuq-UUID` 子目录，再调用 `AddSharedLink`。此 RPC 会修改专用云盘目录，不是只读分享解析。官方响应为 Empty，不能把响应成功当作文件已出现。
- 只枚举新子目录的根层文件，不递归。专用 intake 根目录的元数据枚举仅用于容量限制，不返回成员，也不枚举私人云盘根目录。未导入完成、目录内只有文件夹或能力不支持时会明确失败。
- `resolve(source,file)` 验证 HMAC 回执、分享身份和实时文件 ID/大小/可用 SHA-1，然后调用 `GetDownloadUrlPath(..., get_direct_url:true)`。
- **只使用 `directUrl`**。缺失时不使用 `downloadUrlPath`、WebDAV、CD2 `/static/`、VPS 文件中转或其他 provider 自动回退。传到节点的只有短期云盘 URL 和获准的有限请求头。

## 服务端配置

`configuredCloudDriveProvider({receiptKey, configPath})` 返回适配器。未指定 `configPath`（默认取 `GPUQ_CLOUDDRIVE_CONFIG`）返回 `null`。只接受绝对路径的普通文件，最终路径不得为符号链接；文件须归当前服务 UID 所有、无组/其他人权限，且不超过 32 KiB。建议 `0600`、父目录 `0700`、只读挂入服务容器。配置不能由成员 API 提交或回显，不能提交到 Git。

先用最小关闭配置：

```json
{"enabled": false}
```

管理员完成授权后，按**实际核验身份**填写完整配置。下面只是字段示例，不是可直接投产的账号或已验收状态：

```json
{
  "enabled": true,
  "capabilityVerified": false,
  "endpoint": "http://127.0.0.1:19798",
  "allowInsecureLoopback": true,
  "intakeRoot": "/实际云盘名/gpuq-intake",
  "cloud": {
    "name": "实际 CloudAPI.name",
    "userName": "实际 CloudAPI.userName",
    "path": "/实际 CloudAPI.path"
  },
  "apiToken": "仅服务端保存的作用域受限 API 令牌",
  "downloadHosts": ["aliyundrive.net", "aliyuncs.com"],
  "maxIntakes": 100
}
```

`capabilityVerified` 只在真实分享与直链验收通过后设 `true`。`connected()` 仅表示两个显式配置开关打开，**不是当前在线、账号登录正常或端到端验收成功的证明**。适配器固定公开 `backend: "clouddrive"`，`configuration()` 只返回配置开关与能力验收标记，不含服务地址、账号、路径或令牌。正常 TLS 校验不关闭；明文 gRPC 只允许显式批准的 `127.0.0.1` / `::1` 回环端点。若门户在另一台机器，回环必须是已授权的 3090 管理隧道；适配器不创建隧道、不暴露 19798、不继承 HTTP 代理。仅配置一处后端，不为每个节点安装 CD2。

`receiptKey` 必须是至少 32 字节、跨重启稳定的服务端 Buffer，可由现有服务密钥派生；它不放进上述 JSON，也不发送节点。更换它会让旧回执失效。优先使用具有必要权限和有效期的 CD2 API 令牌；代码也提供 `cloudDriveToken(transport,{userName,password,totpCode?})` 进行服务端凭据交换，但配置加载器不保存/接受密码、不进行交互登录。所需权限最少涵盖列表、创建文件夹、分享转入和直链读取；部署前要核验 CD2 版本实际权限效果，不能声称云盘账号本身被目录级隔离。

门户调用约定：

```js
const provider = configuredCloudDriveProvider({receiptKey: serviceKey});
const files = await provider.list({shareId, password});
// 成员响应只挑选 id/name/size；原始 file 包含私有 cloudDriveReceipt。
// 整个原始 file 与 source 沿用 cloud-import 加密持久化，供重启后 resume。
const {url, userAgent, additionalHeaders} = await provider.resolve(source, file);
```

回执是签名而非加密，包含内部 CD2 路径和云盘身份，**不可发送成员、日志、命令行或公开审计字段**。门户必须继续把它放在原有加密导入记录中。成员仍须经过门户登录、机器额度授权和分享来源验证。`approveShare` 可选回调用于额外服务端政策，不要求每份分享人工审批。成员无权提供 CD2 路径、目录、云盘身份、凭据或任意请求头。

## 下载描述符及限制

返回 `{url,userAgent?,additionalHeaders}`，不是文件内容。URL 必须为 HTTPS/443、无用户信息/片段/IP 字面量，且命中服务端配置的域名白名单（精确域或点边界子域）；拒绝 CD2 后端自身主机。默认只允许 Aliyun Drive/OSS 云盘下载域。实际新增域名须先确认其用途，不为通过测试放宽到任意域。

UA 最长 512 字节且限可打印 ASCII。附加头仅接受 `Referer` / `Origin`，值须为官方 `https://www.alipan.com/` 或 `https://www.aliyundrive.com/` 根地址，不含查询、片段或用户信息。`Cookie`、`Authorization`、`Host`、`Range` 等均拒绝；需要这些头的返回暂不支持，不静默丢弃后假称成功。适配器拒绝把当前服务端 API 令牌（包括 URL 编码形式）反射到直链、UA 或附加头。门户在发节点前再次严格验证描述符字段、URL 和头值；成员不能提交描述符。节点仍须独立执行逐跳 DNS/公网地址/TLS 固定连接校验、限制重定向及转发头，适配器的域名检查不能代替节点 SSRF 防护。

每 RPC 8 秒、每操作 30 秒；最多 2 个并行操作、其中同时最多一份分享转入、30 次操作/分钟；流式清单最多 500 条、64 个消息、累计 2 MiB，单消息最多 1 MiB。无自动写重试。专用 intake 累积默认最多 100 条目（可调 1–1000），同时有本进程创建计数；失败创建/导入占用保守计数。独占使用该 intake；不支持多个门户进程同时写入同一 intake 的分布式配额。不会自动删除云端目录，未完成或失败的隔离子目录需管理员确认后人工清理，避免误删或再次转入覆盖。

## 门户维护操作与持久断开

以下为现有门户调用通道的 API 操作名，参数均为 `{}`；断开和重连只允许管理员。没有新增扫码替代、浏览器绕路或成员凭据接口。

- `cloud.info`：只返回配置状态，不发 RPC。`backend:"clouddrive"`、`managedExternally:true` 明确授权由专用后台管理；`status` 为 `configuration_disabled`、`capability_unverified`、`disabled` 或 `configured`。`configured` 不表示实时连接通过。旧兼容字段 `aliyunConnected` 仅为当前入口是否已配置启用。
- `cloud.auth.disconnect`：先把独立 `cloud_provider_settings` 表中 CD2 的 `disabled` 标记持久化，再取消本进程解析/授权并清空临时检查结果。SQLite 关闭重开后仍禁用；**不会删除旧原生 Aliyun 的 `cloud_secrets` 凭据，不会删除 CD2 云盘账号或撤销令牌**。已经签发给节点的短链可能继续有效，正在下载的任务需另行取消。
- `cloud.auth.reconnect`：重新读取服务端私有配置，仅当 `enabled:true` 且 `capabilityVerified:true` 时清除 CD2 持久禁用标记。它不发 RPC、不扫码、不登录、不替代外部授权或真实验收。私有配置缺失、禁用或未验收则保留禁用标记。原生 Aliyun 后台不支持该操作。

CD2 的 `cloud.auth.begin/poll` 返回“由管理员在专用后台和私有配置中管理”。源码级 `clear()` 仍只是内存取消；应通过上述门户断开 API 获得持久效果。`close()` 额外关闭 gRPC 通道。每次授权状态变更会阻断尚未完成的旧解析结果，避免它在断开后才把短链交给节点。

分享检查及加密导入记录绑定解析后台。旧原生 Aliyun 记录默认归原生后台；CD2 记录带 `backend:"clouddrive"`。切换后台后不能把另一后台的旧文件回执拿来续传，不会自动回退到另一服务或中转文件。普通 HTTPS 直链不依赖 CD2 开关，仍可独立使用。

测试：`node --test tests/clouddrive-provider.test.js`。测试只用注入数据和本机临时 gRPC 服务，不访问3090、不登录、不绕过被阻止的 UI，也不证明实际会员速度或分享支持。
