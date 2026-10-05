# 后端接口交接

面向前端开发者，汇总现有终端、数据上传和云文件接口。这里定义的是兼容契约，不表示每台节点已启用所有能力；部署代码、入口可达和业务验收是三件不同的事。详细说明见 [独立终端](TERMINAL_SESSIONS.md)、[校内直传](DIRECT_UPLOAD.md) 和 [私人云文件](CLOUD_FILES.md)。

## 通用调用

使用已有的已认证 `POST /api/call`：

```json
{"operation":"terminal.open","args":{"machine":"SERVER_ID","mode":"new","key":"NEW_UUID","clientId":"CLIENT_UUID"}}
```

示例中的 ID 均须替换为实际值。浏览器沿用门户的 HttpOnly 会话 Cookie 和同源请求；CLI 沿用 Bearer 会话。不要另造登录、CSRF 或节点鉴权流程。

- 成功响应取 `result`；`principal` 是当前登录身份。部分操作附带 `state`，但 `terminal.exchange` 不返回完整仪表盘，不能要求每次响应都有 `state`。注销后 `principal=null` 是正常结果。
- HTTP 非成功响应按 `error` 展示，不能把请求已送出或 HTTP 200 当作后台任务完成。
- owner、账号角色和节点执行凭据由后端确定。不要在 `args` 中添加 `userId`、`username`、角色或宿主机绝对路径。
- 写请求的响应丢失，意味着结果未确认。不要自动重发终端输入、换一个 UUID 重启云任务，或把文件块改走另一条路径；先查原 ID 和服务端确认的状态／偏移。

## 个人容器项目：创建与固定发布

项目沿用同一个 `/api/call`，详细工作流见 [项目与环境](PROJECTS.md)。创建个人容器项目的请求是：

```json
{"operation":"projects.create","args":{"machine":"SERVER_ID","project":"experiment-a","environmentMode":"oci"}}
```

`project` 须匹配 `^[a-z][a-z0-9_-]{0,47}$`。`environmentMode` 只用于创建，取 `shared`、`isolated` 或 `oci`；省略时沿用共享模式。同名项目不能改换模式，失败时不自动降级或创建替代项目。创建成功须确认 `result.environmentMode === "oci"`，不能把 HTTP 200 当作容器模式已确认。

| 操作 | `args` | 成功的 `result` |
| --- | --- | --- |
| `projects.list` | `machine` | `{projects: [...]}`，每项为项目状态 |
| `projects.create` | `machine`、`project`，可选 `environmentMode` | 项目状态，创建时通常为 `DRAFT` |
| `projects.status` | `machine`、`project` | 项目状态及适用时的发布回执／进度 |
| `projects.publish` | `machine`、`project`、本次发布 UUID `key` | 后台发布状态，不占 GPU，不等于发布完成 |

项目状态包含 `project`、`environmentMode`、`state`、`createdAt`、`releases`、`latestReadyRelease`、`offlineAssetsPath`。`releases` 项包含 `release`（64 位小写十六进制）、`state="READY"`、`createdAt`、`bytes`、`entries`。顶层状态可能是 `DRAFT`、`SYNCING`、`PUBLISHING`、`READY`、`FAILED` 或 `UNKNOWN`；失败详情和进度仅在返回时展示，不能因存在旧 READY 版本就宣称新发布完成。

发布前必须显式结束该项目的全部开发终端，`detach` 不算结束。每次明确发布生成一个 `key`，受理后用 `projects.status` 读取进度；状态查询只传 `machine`、`project`，不传 `key`、不循环调用 publish。保留原 `key`，仅当 `publication.id` 与它一致、`publication.state="READY"` 且 `publication.release` 出现在 READY 版本清单中，才确认本次发布成功；训练固定该 release。响应丢失先查询状态，若需确认原请求仍使用同一个 key，不换新 key 重复发布。`UNKNOWN` 或缺少对应回执时不能猜测成功。

账号须仍启用且具有所选机器的有效授权，节点还须显式启用个人 OCI 并允许该账号；管理员角色不自动绕过这些检查。当前真实正式验收范围是一个 RTX 3090 节点上的受控账号，不代表已向全部账号和节点开放。owner 由后端登录身份确定，HTTP 不接受客户端指定 `owner`、`userId`、角色、镜像或引擎参数。进入容器用下述 `terminal.open` 加 `project`，不加 `hostAdmin`；容器内 root 不等于宿主机 root，开发终端没有 GPU。

## 自动选机与不可变项目复制

`jobs.submit` 的原显式 `machine` 行为与提交摘要保持不变。自动选机改用 `machine:"auto"`（也可省略 machine），并传 `machineSelection:{mode:"auto",candidates?:["SERVER_ID",...]}`；必须同时带固定 `project` 和完整 `release`。候选列表可省略，但不接受空列表、重复或未知机器。其余卡数、显存、数据集、调度字段沿用原接口，不接受客户端指定来源路径、镜像或用户身份。

后端只读筛选机器后，将唯一实际 `machine`、原提交 `digest`、`machineSelection` 和 `projectPreparation:{from,project,release,state,operationId?}` 随任务落库。项目／数据准备阶段为 `PREPARING_DATA`，不占 GPU 额度；后续逐阶段重新检查权限、维护、固定版本和额度。超时、刷新或重启只能观察这个目标和原操作，不能换机器或新建提交键。UI 展示实际 `machine`，用 `projectPreparation.state` 与 `dataPreparation` 显示进度；不把准备中的任务误画成已拿到显卡。

手动项目副本使用正常认证接口 `projects.replicate {from,machine,project,release,key}`，查询／取消为 `projects.replication.status {id}` 和 `projects.replication.cancel {id}`。只允许账号自身、两端机器均仍授权的固定 OCI 版本。响应包含 `id,state,from,machine,project,release,bytes?,totalBytes?,error?,developmentChanged:false`；状态包括 PREPARING、DISPATCHING、RUNNING、UNKNOWN、SUCCEEDED、FAILED、CANCELING、CANCELED。UNKNOWN 不证明未启动，不能换 key 重发。内部传输票据不会返回前端。

项目复制只复制不可变代码和镜像，不迁移正在运行的容器、草稿、开发 HOME 或训练结果。数据集使用原数据复制服务。部署方需同时启用门户模块、节点 portable-project 能力与固定 TLS peer，配置缺失时拒绝自动选机，不回退为未隔离执行。

## 终端：新建与重连分开

所有操作均包含 `machine`。可选上下文为 `project`、`dataWorkspace`、`hostAdmin`；重连及后续操作必须保持原上下文。项目、个人数据终端和宿主机 root 入口不能混用。宿主机 root 仍受管理员身份、机器授权和节点配置约束，不等于个人容器内的 root。

| 操作 | 必需字段（除 `machine` 外） | 行为 |
| --- | --- | --- |
| `terminal.open`，`mode="new"` | 新 UUID `key`、`clientId` | 新建独立 PTY；不携带旧 `id`／`writerToken` |
| `terminal.open`，`mode="reconnect"` | 原 `id`、新连接 UUID `key`、`clientId` | 附着原会话，不替换不可达的终端 |
| `terminal.exchange` | `id`、`clientId`、`writerToken` | 读取输出，可带输入和窗口尺寸 |
| `terminal.detach` | `id`、`clientId`、`writerToken` | 释放写入权，保留终端及命令 |
| `terminal.close` | `id`、`clientId`、`writerToken` | 显式结束这一会话，不影响其他会话 |

`open.result` 返回 `id`、`hostAdmin`、`clientId`、`writerToken`、`leaseExpiresAt`、`mode`。将写入凭据保存在当前连接内存中，不放进多客户端共用的账号缓存、URL 或日志。保存会话 ID 供用户明确重连。

`exchange.args` 可包含：`input`（Base64，长度上限 12,000 字符）、`offset`、`rows`、`cols`。响应沿用 `data`（Base64）、`offset`、`exited`；按返回偏移读取，不从本地猜测偏移。逐条等待输入请求完成；门户按会话 FIFO 排序，单会话最多 4 个待处理请求、全局最多 24 个，超限返回 429。

单写租约为 30 秒，正常 exchange 续约。租约过期不会杀掉 PTY，但旧凭据不能继续输入或关闭它。另一客户端持有写入权时，普通重连拒绝；只有用户明确确认后才传 `takeover: true`。接管会换写入凭据，不能撤回已经被接受的命令。

网络错误／切换页面不应触发 `close`，也不应自动新建替代终端。明确“断开”使用 `detach`；显式“结束终端”才使用 `close`。持久 SSH 通道是后端内部优化，不新增浏览器流协议，也不改变上述字段或旧节点兼容路径。

## 数据集上传：控制面与文件字节分开

旧版本首次归档的管理入口是 `datasets.archive.enroll {machine,dataset,version,ownerId,key}`：`machine` 为已授权的本地训练节点，`version` 为完整哈希，`ownerId` 为不可变账号 ID，`key` 为本次 UUID。仅当前启用的管理员可调用；重复请求沿用同一 key，不在列表刷新时自动调用。只有指定 HDD 已有同名同版单 owner 的受保护 READY 原件才接受，返回归档阶段而非立即完成。阶段查询继续使用现有归档状态；`archive-retry` 不能代替首次纳管。此管理入口不放在普通用户操作栏。

个人显示名使用 `datasets.label.get {machine,dataset}` 读取，`datasets.label.set {machine,dataset,displayName,revision}` 修改。名称为 1–80 个可见字符，允许中文，拒绝控制字符；`revision` 必须沿用最近查询值，409 冲突后请用户刷新决定，不自动覆盖。响应有规范逻辑 `dataset`、原 `name`、可空的 `displayName`、`revision`、`ownerId` 和 `scope:"personal"`。管理员代管时可显式增加 `ownerId`，普通成员不能指定他人。该名称仅作用于这位用户的显示视图，不重命名节点登记、版本或训练挂载路径，也不改变共享数据权限。

门户控制面顺序：

1. `datasets.upload.begin`：`machine`、`name`、UUID `key`、`manifestBytes`、`manifestSha256`、`totalBytes`、`entries`；仅用户明确同意大文件中转时增加 `allowRelay: true`。
2. 从 `result` 保存 `uploadId`、`state`、`manifestOffset`、`chunkBytes` 和 `uploadTransport`。后者包含 `protocol`、`directAvailable`、`reason`、`relayLimitBytes`、`relayAllowed`。能力存在不代表当前电脑一定能连到节点。
3. 可直传时调用 `datasets.upload.direct-ticket`，参数为 `machine`、`uploadId`；使用它返回的授权入口。
4. 清单传完后通过门户 `datasets.upload.seal`；文件传完后通过门户 `datasets.upload.commit`。二者均传 `machine`、`uploadId`。
5. 用 `datasets.upload.status` 查询同一上传；可增加相对 `path` 查询文件。`SEALING`／`PUBLISHING` 是处理中，只有 `READY` 且数据集、版本和校验结果有效才表示可用于训练。

清单格式沿用 `schema: 1`、`directories`、`files`；文件条目包含 `path`、`size`、`sha256`。清单最多 64 MiB、目录及文件合计最多 500,000 项。路径必须是安全相对路径，遵守现有客户端的链接、文件身份和变动检查。

### 直传数据面

票据返回 `available`、`protocol="dataset-upload-v1"`、`endpoint`、`ticket`、`expiresAt`、`certificateSha256`、`chunkBytes`，新版另含可选的 `maxChunkBytes`。仅使用本次授权的 `endpoint`，不硬编码某台节点、IP 或门户地址。

| 节点请求 | 数据 |
| --- | --- |
| `POST /v1/uploads/<uploadId>/manifest?offset=<offset>` | 原始清单块 |
| `POST /v1/uploads/<uploadId>/chunk?offset=<offset>&path=<encodedRelativePath>` | 原始文件块 |
| `GET /v1/uploads/<uploadId>/status[?path=<encodedRelativePath>]` | 已确认的状态／偏移 |

设置 `Authorization: Bearer <ticket>`，POST 使用 `application/octet-stream`。清单块仍不超过 `chunkBytes`（1 MiB）；文件块可采用票据的 `maxChunkBytes`（仅允许 1 或 16 MiB），缺省回到 1 MiB。旧客户端继续发送 1 MiB 块，不需改变接口。节点在读取请求体前验证票据及其限额，确认仍意味着本块已持久写入，不能通过去掉落盘保证换取速度。

客户端应从 1 MiB 文件块起步：确认耗时低于 500 ms 后可升到已授权上限，耗时超过 8 秒则降回 1 MiB，避免慢网络被迫用大块。清单、VPS 中转及哈希扫描的块大小不变。续期授权可能降低限额；尚未发送的大块不能越过新限额，未知响应不自动重发或改走中转。网页可仍用原有 1 MiB 实现，不应仅凭后端升级就宣称网页已提速。

节点成功响应为 `{ok:true,result:...}`，不同于门户响应；manifest／chunk 的 `result.offset` 必须确认整块已写入。文件 status 的 `result.file` 包含路径、大小、SHA256、偏移及完成标记。

浏览器使用正常受信任 HTTPS、`credentials: "omit"`，不发送门户 Cookie。部署方须配置精确允许的门户 origin；遵循 Authorization／Content-Type 的 CORS 预检和需要时的私有网络预检，不用通配符或跳过证书检查。CLI 的门户签发证书固定实现不能直接代替浏览器证书信任。

票据有效期 5 分钟。过期／撤销后回门户查询并重新授权；续传仍用同一个 `uploadId` 和节点确认的偏移。不要从“请求发出”推断写入完成。节点禁用、配置变更和撤销会拒绝旧票据；账号权限变更不应被描述为所有已签票据立即失效。

### 中转边界

沿用 `auto`／`direct`／`relay` 路由选择。`auto` 优先已授权直传；明确无直传入口时，最多 256 MiB 可走门户中转，大于该值必须用户明确同意。直传认证、TLS、网络或响应不确定时，不自动重发到 VPS；`direct` 从不允许中转。显式中转的 manifest／chunk 使用门户 `datasets.upload.manifest`／`datasets.upload.chunk` 的规范 Base64 `data`，不是 raw HTTP。

个人可写数据空间的 `datasets.workspace.put` 是另一套现有操作，当前仍是门户中转，不受数据集直传票据授权。不要仅改按钮文案就声称它已直传，也不要把 dataset 票据用于任意个人文件路径。大于 256 MiB 的 `data put` 同样要求显式中转同意。

## 云端文件：服务器文件，不是电脑上传

`cloud.files.*` 处理选定节点上当前用户的个人数据文件；成员不会得到后台云账号、CD2 令牌或私人云盘浏览权限。

| 操作 | 参数（均包含 `machine`） |
| --- | --- |
| `cloud.files.info`／`list` | 无额外参数 |
| `cloud.files.upload` | UUID `key`、个人数据空间相对 `path` |
| `cloud.files.verify` | UUID `key`、`fileId` |
| `cloud.files.download` | UUID `key`、`fileId`、新目标相对 `path` |
| `cloud.files.status`／`cancel` | `operationId` |

先用 `info.result.enabled` 判断该节点是否启用。`list.result` 为 `files`、`total`、`limit`；操作响应沿用 `operationId`、`action`、`fileId`（适用时）、`path`、`state`、`phase`、`bytes`、`totalBytes`、`sha256`、`error`／`errorCode`、`canResume`、`vpsRelay` 等已有字段。`QUEUED`／`RUNNING` 不是完成，`VERIFYING` 也不是可靠副本；显示真实状态，只有 `VERIFIED` 后才允许按现有规则取回。

后台节点与云盘直接传文件，门户负责鉴权及元数据。不能把这组接口绑定电脑文件选择器后称为“电脑直传云盘”；电脑文件必须先通过可达的节点直传、服务器拉取链接或明确中转进入个人数据空间。上传回执丢失先查原操作 ID，不换 `key` 重传；下载续传复用原键和目标身份，由服务端核验前缀，不覆盖现有文件。

另有 `cloud.inspect` 和 `cloud.import.start/status/list/cancel/resume/discard` 用于已批准来源的节点直接取件。HTTPS 来源和阿里云盘分享解析是不同能力；后台已登录、`aliyunConnected` 或 `nodeDirect` 字段不能证明分享链接能够下载。

## 验收范围与未开放边界

截至 2026-10-05，受限测试节点完成普通成员的真实 4 MiB 校园直传、1 MiB ACK 后断线续传、发布后独立全文 SHA256 校验，以及可信证书、允许 origin／外部 origin 拒绝检查；私人云文件也完成普通成员 4 MiB 上传、核验、取回和独立读回。它们不是全节点、全校园来源、校外可达或 TB 级性能验收。

- **网页接入须单独验收**：已有目录上传仍可能选择门户中转。按真实请求路径呈现路线，不能因 CLI／节点验收通过就标记所有网页上传已绕过 VPS。
- **公网阿里分享尚不可宣称可用**：当前 CD2 分享接入能力未开放，原生分享下载链接请求实测返回 HTTP 410；保留已有节点云文件功能，不用反复重试或扩大后台权限伪造成功。
- **能力按节点和入口判断**：个人容器、持久终端和直传是独立的启用范围，不从管理员角色或仓库源码推断已全面部署。
- **证书与网络是部署责任**：入口范围、证书更新和客户端真实可达性须持续核验；默认不承诺自动续签或任意校园 NAT 穿透。

前端实现完后至少验收：零授权拒绝、独立终端与显式接管、断线不重放、跨账号拒绝、真实 raw 文件路径、续传偏移、最终校验及无直达入口的大文件拒绝。不得只用健康页或文案截图代替业务测试。
