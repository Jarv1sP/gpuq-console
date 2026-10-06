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
- 执行桥暂时断开返回 HTTP 503，等待超时为 504，响应损坏为 502，不应显示成参数错误或任务失败。CLI 对明确只读查询（含 `host.status`）采用有界退避，最多 8 次请求、65 秒总期限，并保持原机器和任务 ID；`host.exec`、`host.cancel` 与终端输入绝不因此自动重发。查询失败不代表后台命令停止，应重新查询原句柄。

### 任务显示名与节点标签

队列、显卡进程详情和任务列表的 `name/description/submitter` 是显示信息，不是执行身份。节点采集白名单保留有界纯文本 `display_metadata`；平台关联任务仅在同机器、精确原生任务 ID、关联无歧义且登录用户名一致时采用它。管理员查询未关联平台的原生任务时，只有新鲜、已连接的节点和唯一任务 ID 才采用合法标签的 `name/description`，署名仍保留原生任务 owner，不从标签推断平台账号。普通成员对这些任务仍只收到脱敏占用。重复 ID、模糊关联、旧节点或非法标签回退原显示；UNKNOWN 状态保持未知，不新增 argv、路径、日志或操作权限。

已通过原生 GPUQ 身份围栏 `set-display` 修改的同账号标签不会被常规 reconcile 改回提交时名字。节点返回 `displaySync.state:"PRESERVED"` 和允许的标签，门户保存其显示缓存，让任务列表与队列一致；原 `job.name`、不可变 spec、提交 key/digest、优先级、资源和结果路径均不改变。此修复需配套采集和任务显示 helper；它不新增网页/CLI 标签编辑、项目归并或项目退役接口。

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
| `projects.local-import.begin` | `machine,project,key,sourcePath,destinationPath` | 本人同机数据区→草稿新目录；字节不经门户 |
| `projects.local-import.status` / `.cancel` | `machine,project,key` | 原固定操作状态／取消请求 |

项目状态包含 `project`、`environmentMode`、`state`、`createdAt`、`releases`、`latestReadyRelease`、`offlineAssetsPath`。`releases` 项包含 `release`（64 位小写十六进制）、`state="READY"`、`createdAt`、`bytes`、`entries`。顶层状态可能是 `DRAFT`、`SYNCING`、`PUBLISHING`、`READY`、`FAILED` 或 `UNKNOWN`；失败详情和进度仅在返回时展示，不能因存在旧 READY 版本就宣称新发布完成。

发布前必须显式结束该项目的全部开发终端，`detach` 不算结束。每次明确发布生成一个 `key`，受理后用 `projects.status` 读取进度；状态查询只传 `machine`、`project`，不传 `key`、不循环调用 publish。保留原 `key`，仅当 `publication.id` 与它一致、`publication.state="READY"` 且 `publication.release` 出现在 READY 版本清单中，才确认本次发布成功；训练固定该 release。响应丢失先查询状态，若需确认原请求仍使用同一个 key，不换新 key 重复发布。`UNKNOWN` 或缺少对应回执时不能猜测成功。

账号须仍启用且具有所选机器的有效授权，节点还须显式启用个人 OCI 并允许该账号；管理员角色不自动绕过这些检查。当前真实正式验收范围是一个 RTX 3090 节点上的受控账号，不代表已向全部账号和节点开放。owner 由后端登录身份确定，HTTP 不接受客户端指定 `owner`、`userId`、角色、镜像或引擎参数。进入容器用下述 `terminal.open` 加 `project`，不加 `hostAdmin`；容器内 root 不等于宿主机 root，开发终端没有 GPU。

### 同机项目导入协议

`key` 是固定 UUID；SOURCE 仅当前账号个人数据工作区的相对目录，DEST 仅本人项目草稿的新目录、父目录预先存在。先结束两端全部终端，并完成或正规取消 pending uploads。维护状态阻止 begin、允许 status/cancel；每次重验当前账号和机器授权，不接受 owner/userId/hostAdmin 或任意宿主路径。旧 `/data1/...` 需先明确整理到本人个人数据区，不支持直接导入。

返回 `protocol:"project-local-import-v1",key,project,state,phase,sourcePath,destinationPath,files,bytes,draftChanged`，完成另有 `manifestSha256`，失败/未知可有 `error`。状态 IMPORTING/COMMITTING/IMPORTED/FAILED/CANCELED/UNKNOWN；阶段 SCANNING/COPYING/VERIFYING/COMMITTING/IMPORTED/STOPPED/CANCELED。仅 IMPORTED 且 draftChanged=true 证明新草稿目录完成，不是环境 READY 或 GPU 分配。项目 status/list 在 `localImport` 附回执，未确认时顶层显示 IMPORTING/COMMITTING/UNKNOWN。

两端持久围栏早于 systemd launch。完整 SHA、源 CAS 后使用 Linux `renameat2(RENAME_NOREPLACE)` 原子提交；能力缺失拒绝受理，不降级为检查后 rename。cancel 确认整组停止后只清理尚未提交的私人 staging；COMMITTING/提交回执不明仍保留围栏。通用传输仅重试 status，不重放 begin/cancel。配套门户、VPS 执行桥、项目/个人数据 helper 和 runtime 依赖清单应一起发布。执行桥仅新增固定的 `files.upload.list/cancel` 与 `projects.local-import.begin/status/cancel`；它不代替门户当前账号授权或节点 owner 检查，不开放任意操作、宿主路径或 shell。

## 自动选机与不可变项目复制

`jobs.submit` 的原显式 `machine` 行为与提交摘要保持不变。自动选机改用 `machine:"auto"`（也可省略 machine），并传 `machineSelection:{mode:"auto",candidates?:["SERVER_ID",...]}`；必须同时带固定 `project` 和完整 `release`。候选列表可省略，但不接受空列表、重复或未知机器。其余卡数、显存、数据集、调度字段沿用原接口，不接受客户端指定来源路径、镜像或用户身份。

后端只读筛选机器后，将唯一实际 `machine`、原提交 `digest`、`machineSelection` 和 `projectPreparation:{from,project,release,state,operationId?}` 随任务落库。项目／数据准备阶段为 `PREPARING_DATA`，不占 GPU 额度；后续逐阶段重新检查权限、维护、固定版本和额度。超时、刷新或重启只能观察这个目标和原操作，不能换机器或新建提交键。UI 展示实际 `machine`，用 `projectPreparation.state` 与 `dataPreparation` 显示进度；不把准备中的任务误画成已拿到显卡。

个人累计用卡额度只约束普通成员；当前启用的管理员对共享、独占、手选和 AUTO 一致豁免。单任务物理卡数、显存、能力、owner-only 数据授权、优先级和显式让位规则不变，资源不足交给节点排队；不清除既有任务或租约，也不更改成员原始额度。全平台 5000 条历史和每人 10 个准备中任务的上限保留。新任务内部 `dispatchPending:true` 随记录持久化（不下发到节点或返回客户端）；首次 sync 在串行队列内重验当前角色/启用状态、机器和个人额度及管理员专属优先级，先持久化标记为 false 再开始远程调用，等待回包不占用串行队列。降级后未派发任务不沿用管理员豁免；已尝试派发、旧无标记或回执未知任务继续原同步路径，不凭角色变化停止训练或释放资源。该标记不是节点成功证明。

界面按当前账号的 `enabled:true` 与 `role:admin` 显示「请求卡数／免个人额度」，保留进行中和排队的真实请求统计，但不把清单派生的 `total` 或 `limits` 画成管理员累计额度上限，也不以 `total-used` 禁用管理员提交。单次 `cards.max` 仍来自目标机器物理卡数；成员继续显示占用／额度上限。工作台、提交预检、总控、算力摘要和个人账号页口径一致。

手动项目副本使用正常认证接口 `projects.replicate {from,machine,project,release,key}`，查询／取消为 `projects.replication.status {id}` 和 `projects.replication.cancel {id}`。只允许账号自身、两端机器均仍授权的固定 OCI 版本。响应包含 `id,state,from,machine,project,release,bytes?,totalBytes?,error?,developmentChanged:false`；状态包括 PREPARING、DISPATCHING、RUNNING、UNKNOWN、SUCCEEDED、FAILED、CANCELING、CANCELED。UNKNOWN 不证明未启动，不能换 key 重发。内部传输票据不会返回前端。

明确失败或取消后，用户可选择 `projects.replication.retry {id,key}`，`key` 是新的重试 UUID；响应不确定时沿用这个 key。只有旧操作两端已停止、临时运输数据已清理、源票据已撤销且权限仍有效才接受；返回新复制及 `retryOf`，原失败记录不改写。不要让页面刷新自动调用 retry，也不要自动重提旧训练。后台发现撤权或取消时，先阻断源票据读取，再等目标停止和清理；目标暂时失联时继续保留收尾状态与临时文件。

项目复制只复制不可变代码和镜像，不迁移正在运行的容器、草稿、开发 HOME 或训练结果。数据集使用原数据复制服务。部署方需同时启用门户模块、节点 portable-project 能力与固定 TLS peer，配置缺失时拒绝自动选机，不回退为未隔离执行。

## 终态训练的只读节点观察

`jobs.watch {jobId}` 对已保存终态保留原 `state`、时间、取消与资源字段，额外返回 `nativeObservation`；`jobs.diagnostics {jobId}` 在原诊断包外增加 `portalTerminal` 与同一观察。观察为 `readOnly=true`、`status=CONFIRMED|UNKNOWN`，确认时含节点 `state`、`nativeVersion`、`observedAt`、`latestAttempt`、`latestRetry`、`retryDetected` 和 `manualRecovery`。`retryDetected` 只在原节点 ID、不可变规格、submit key、同快照版本及该节点任务的最新 `JOB_RETRIED` 事件均核对、且事件晚于原 attempt 的节点结束时间时为 true；排队重试可以尚无新 attempt。

这些字段仅证明观察时刻，不是持续一致或重新执行授权。缺少旧节点能力、身份／事件／时间基线不全或查询失败不得推断任务复活；UNKNOWN 不覆盖原历史。不要用 `nativeObservation.state` 改写主 `state`、发起取消／提交、清除 `cancelRequested`、重新占用额度或重开已释放 hold。`manualRecovery.reason=HOST_RETRY_REQUIRES_EXPLICIT_RECOVERY` 表示已观察到宿主重试，`TERMINAL_DIVERGENCE_UNCONFIRMED` 表示状态差异但重试证据不足。普通请求不接受 node ID、spec、retry event、角色或宿主路径；内部只读证明不能由客户端提供。CLI `watch` 仍按门户原终态退出，并明确显示它与节点观察的区别。

### 下游任务的完成核验

`jobs.completion {jobId}`（CLI：`gpuctl completion JOB_ID --json`）提供同一不可变任务的最新成功证明，不修改 `state/jobs` 的原终态。返回 `protocol:"job-completion-v1"`、`completed`、`state:SUCCEEDED|UNCONFIRMED`，以及 `jobId,userId,machine,nodeJobId,project,release,specSha256,portalHistory,nativeObservation`；成功另含 `completedAttempt,observedAt,nativeVersion`。CLI 已核实成功退出 0，未确认退出 2，请求错误退出 1。

原生手动重试成功后，历史终态不再自动同步，可能仍保留数据租约。此时 `completion` 仍为未确认，不能仅凭日志中的成功忽略资源保护。本人或管理员可显式执行 `gpuctl reconcile-resources JOB_ID --json`（`jobs.reconcile-resources {jobId}`）：只对账已有历史终态任务，不提交、重跑或取消任务，不修改原失败历史、取消标记和配额。服务端固定原生任务 ID、最新 attempt ID/序号和原生版本；节点在 job 锁内重读并核对完整规格、终止状态、全部消费者及代际，再正常收尾数据租约。缺失身份、运行中、未知或并发重试均拒绝；不得通过删除收据代替释放。成功回包 `protocol:job-resource-reconciliation-v1, resourcesReleased:true, reconciledNative, portalHistory, completion`，其中 `completion` 是收尾后的另一次只读核验，不保证后来新重试也已完成。该命令是显式变更，不自动重试；丢失响应可先用 `completion` 查询，再按原任务重新对账。

`completed:true` 必须同时满足：固定节点/账号/submit key/不可变 spec 匹配；最新 attempt 为 `EXITED_SUCCESS`、exit 0、开始结束时间有效；native watch 已确认 GPU 消费者结束及数据租约收尾；较旧失败之后须有可信重试事件及更高 attempt。门户取消标记、缺少身份或事件基线、节点失联和清理中均返回未确认。仅当前获授权的本人/管理员可读，不接受客户端提交证据；不重放训练、占用额度、释放租约或覆盖失败历史。

下游准入应查询此接口，并核对预期 `jobId/project/release/completedAttempt`，不要将旧 `state/jobs` 的 FAILED 直接当作重试结果，也不要仅凭日志里的成功字样放行。该结果是通过认证 HTTPS 查询得到的时点证据，`specSha256` 只是不可变规格摘要，不是离线数字签名；不证明科学结果质量，后续再次重试可能产生更新状态。

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

## 项目文件上传的确认与恢复

`files.upload.status {machine,project,area:"code",path,totalSize,sha256,uploadId?}` 仅查询当前账号的精确项目文件；首次可省略 `uploadId`，发现同路径、同大小、同完整 SHA 的现存上传。返回 `protocol:2` 及 `ABSENT / UPLOADING / COMPLETE / CONFLICT`；已知上传含原 `uploadId`、`receivedBytes`。`UPLOADING` 还必须有 `resumable:true` 才能续传。维护期间仍可查状态，不能借它写文件、发布或提交任务。

项目 `files.put` 的固定身份由账号、项目、路径、总长度、SHA256、uploadId 共同绑定。中间块重复发送同 offset/bytes 不会追加；最终提交保留完成回执，查询和原最终块恢复会核验目标内容及身份。已提交的目标被他人编辑或替换会拒绝恢复，不回滚或覆盖新内容。rename 已完成但最终回执尚未写入时，保留的 COMMITTING 意图用于核验结果，此时状态为 `COMPLETE,completionPending:true`；客户端须保持原 ID，在 `offset=totalSize` 发送空的 final 块收尾后才可发布，查询本身不写入。不能仅凭项目旧 READY 版本推断这次上传成功。

客户端先查状态，再继续原上传；遇未知 ACK 最多进行三轮有界恢复，且每轮先查询已确认偏移，不换 uploadId 或路径。旧格式未完成记录没有目标变化围栏，同内容返回 `legacy:true,resumable:false`，不同内容返回 `CONFLICT`，需人工核对，不自动清理或从零重开。传统非项目 `files.put` 不增加重放。完成后的恢复只校验目标并收尾回执，不再次 rename；尚未提交的首次上传／续传仍按显式 push 的替换语义执行，上传期间禁止同路径并发终端编辑，不能把平台锁或 stat 检查称为对外部写入的原子 CAS。单文件上限仍为 4 GiB，完成状态的完整 hash 核验可能占用一次文件读取时间；超时只是未确认，不表示文件不存在。

CLI `gpuctl push-status LOCAL [REMOTE] --project PROJECT --machine MACHINE --json` 只读；`gpuctl push` 能恢复同内容的已确认上传。此功能不改变项目字节当前经门户中转的路径，也不冒称项目包走了数据集直传。

无需本机源的清理：`files.upload.list {machine,project,area:"code"}` 返回 `protocol:1,project,uploads`，每项 path/uploadId/totalSize/sha256/state/receivedBytes/cancelable/legacy，最多 64 个私人待上传对象。`files.upload.cancel {machine,project,area:"code",uploadId}` 只选精确 UUID，返回 `protocol:1,state:"CANCELED"|"ABSENT",uploadId`；ABSENT 不是删除完成证明。正规 UPLOADING/CANCELING 且原目标围栏匹配时，先持久 CANCELING，再清理未提交 staging 并保留幂等取消回执；COMMITTING、旧缺失围栏、身份冲突或目标变化拒绝。不能删除已提交草稿、READY 或结果。取消中 status 可返回 CANCELING，不标为可续传，原已取消 UUID 不能 files.put。list/status 可读重试，cancel 不自动重放；维护期间允许查询/停止，不允许继续上传。

## 数据集上传：控制面与文件字节分开

旧版本首次归档的管理入口是 `datasets.archive.enroll {machine,dataset,version,ownerId,key}`：`machine` 为已授权的本地训练节点，`version` 为完整哈希，`ownerId` 为不可变账号 ID，`key` 为本次 UUID。仅当前启用的管理员可调用；重复请求沿用同一 key，不在列表刷新时自动调用。只有指定 HDD 已有同名同版单 owner 的受保护 READY 原件才接受，返回归档阶段而非立即完成。阶段查询继续使用现有归档状态；`archive-retry` 不能代替首次纳管。此管理入口不放在普通用户操作栏。

若 HDD 尚无这版原件，管理员可在同一首次纳管请求中显式增加 `copyIfMissing:true`。服务只接受配置 HDD 的精确 `ABSENT` 证明；超时、撤权、孤立文件或未知状态都不触发复制。成功受理返回 `QUEUED`，固定登记身份和复制 key 后，复用受信节点传输队列异步建立原件，再完整校验、签发恢复授权并认证本机缓存，最终才是 `ARCHIVED`。受理不是备份完成；在此之前本机副本保持保护。刷新、门户重启、丢响应仍使用原意图及 key，不另建副本；失败需显式重试，取消不自动复活。旧请求不带该字段时保留“原件必须已存在”的行为；同一 key 不能切换复制意图。数据走既有节点传输，不经过 VPS。此字段不开放用户指定来源、URL、凭据或恢复证明。

归档复制期间的内部 `storage.archive.enrollment-check` 不再在全局缓存锁内解析大清单。首次完整校验在锁外执行，前后以单 owner、登记文件、READY 元信息和只读数据根的精确身份复核；重复请求可复用服务私有目录内最多 256 槽的校验摘要，但仍实时检查权限、保护角色、pin 和 staging。替换、注销、权限变更或未知 I/O 不会由旧摘要覆盖；摘要不是租约、恢复授权或 ARCHIVED 证明，完整内容校验仍由封存流程完成。

这项优化仅涉及 `deploy/storage-archive.py` 的内部检查及私有摘要目录。经过生产变体核对后可对该文件做精确原子热更新，新 RPC 使用新实现，不要求中断既有复制或重启 peer、训练、门户。它不改变单块 TLS 连接、目标落盘持久化或当前传输状态，不应把元信息基准的提速直接当作端到端吞吐提升。基准入口为 `tests/archive-enrollment-performance.bench.py`（支持 164,690 / 450,000 条目；临时元信息 fixture，不包含真实文件复制）。

`datasets.archive.retire {machine,dataset,version,ownerId,eventId,recoveryId}` 也是当前管理员专用入口，接受固定 HDD 同机 ingest（无 transfer、未确认归档）或完全未派发的 `QUEUED` ingest。后者必须 transferId/sourceDataset/grantId 均为 null、retryRequested 非 true、没有同 copyKey 的任何传输记录且不是 laneOwner；RPC 前保存持久 retirementIntent 并阻止该行的 dispatch/reconcile，前后复核登记上下文与准入条件。回包丢失或重启只保留待确认 fence，同请求可继续，不推断成功或启动传输。`recoveryId` 是正常注销的 `unregister-` 加 32 位小写十六进制回执，不接收客户端的 mode、grant、证明、路径或角色。后台私有 `storage.archive.retire` 复核原登记身份、完整清单、单 owner、已提交注销与无现存保护，再持久化该事件的 `RETIRED` 墓碑；旧 HDD 协议还检查 worker 从未创建且确认停止，QUEUED 内部模式只证明本来源注销。门户返回 `phase=FAILED` 并保留不可重试的 retired 原因；重复同一回执幂等，换回执、已派发跨机、已 seal 或 UNKNOWN 均拒绝，不清除其他 lane。私有 RPC 不向浏览器公开。

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

固定候选选路沿用 [校内直传](DIRECT_UPLOAD.md) 的 `routeSelection`／`datasets.upload.routes` 协议。全部匿名探测失败时，共享客户端选择器按已批准 `routeId` 输出静态失败分类；CLI 区分连接、超时、TLS／证书固定和回复中的节点／版本不匹配，浏览器无法确认网络原因时保留泛化失败。分类不回显入口 URL、原始异常、响应正文或实际节点身份，也不新增后端 API 字段、请求或票据权限。节点本地监听可用不能代替客户端入口可达；不得以升级客户端诊断冒称已修复网络。发布这项诊断须重建 CLI，并配套发布共享静态模块 `upload-routes.js`；无需更新节点服务。

沿用 `auto`／`direct`／`relay` 路由选择。`auto` 优先已授权直传；明确无直传入口时，最多 256 MiB 可走门户中转，大于该值必须用户明确同意。直传认证、TLS、网络或响应不确定时，不自动重发到 VPS；`direct` 从不允许中转。显式中转的 manifest／chunk 使用门户 `datasets.upload.manifest`／`datasets.upload.chunk` 的规范 Base64 `data`，不是 raw HTTP。

个人可写数据空间的 `datasets.workspace.put` 是另一套现有操作，当前仍是门户中转，不受数据集直传票据授权。不要仅改按钮文案就声称它已直传，也不要把 dataset 票据用于任意个人文件路径。大于 256 MiB 的 `data put` 同样要求显式中转同意。

## 数据仓库：目录发现不授予数据使用权

`datasets.catalog` 对所有启用的登录成员返回全节点白名单元数据；零机器额度时可省略 `machine` 或传 `null`，仅浏览。提供机器时必须是清单内 ID，不能传任意地址。`datasets.capacity`、上传及其他执行接口继续要求机器授权。

版本和每个 `locations` 条目均返回显式 `canUse`。界面不能单凭 `state: READY` 解锁训练；`canPrepare`、复制来源和本机就绪用于执行时都须来自本人有权使用的位置。私有本机 READY 与本人远端 READY 并列时，不可误称本人本机已就绪。后端的准备、标签修改、提交及自动选机也独立检查使用权限。

内部发现只能执行固定 `datasets.list` 元数据读取。响应不转发 owner IDs、文件清单、宿主路径、恢复票据或他人的错误/操作编号，节点 `owners` 不改。未知旧节点授权只按本人受限列表中的精确数据集和完整版本确认，不默认允许。客户端不得提供内部身份或 `hostAdmin`，不因目录可见获得管理权限。

目录发现兼容尚未提供 `datasetDelete:1` 的节点，不要求部署新删除协议。删除能力仍须全节点确认且账号已有机器授权；零额度成员的目录返回 `datasetDelete:0`。新节点的 `deletionPermissions.memberAllowed` 只采用本人受限列表对同机、同数据集、同完整版本返回的许可，不继承内部发现身份的权限；证明失败只关闭删除许可，不把已确认的目录元数据隐藏。

## 已被新版替代的旧归档原件（管理员）

`datasets.archive.retire-authority` 是当前管理员的显式维护操作，不是普通删除或解除固定按钮。参数：

```json
{"machine":"<旧缓存节点>","dataset":"<旧缓存ID>","version":"<旧完整版本>","ownerId":"<所属账号>","recoveryId":"unregister-<旧缓存正常注销回执>","replacement":{"machine":"<新缓存节点>","dataset":"<新数据集ID>","version":"<新完整版本>"},"key":"<固定UUID>"}
```

服务端只接受已确认归档的同一账号旧版及已独立完成认证的新版本，不接受客户端传 grant、清单证明、路径或任意节点。新原件必须实际保留在指定 HDD、处于保护状态，完整清单包含旧版每个文件的路径、大小、SHA256 及目录；`QUEUED`、复制完成或只有 `READY` 都不能替代归档证明。旧缓存必须已经通过正常注销流程移除，其他引用、租约、固定标记、活跃或未知 worker 会阻止退役。

处理顺序为持久化门户退役意图、验证旧缓存 `REMOVAL`、永久封住旧恢复授权、验证新原件、封住旧原件的再授权与读取、移除一个精确匹配的 authority 标记，最后调用正常异步注销。只针对这一旧版本；不会取消训练、移除其他标记或自动删除新副本。后台注销还绑定原登记的文件身份与单一 owner，防止同名版本被重建或共享后误删。

重复相同 `key` 查询并推进原操作，超时不换 key。待确认响应保留 `phase: ARCHIVED` 但 `originalRetained: false`，并包含 `retirement.state`（如 `FENCING`、`UNREGISTERING`、`FAILED`、`UNKNOWN`）；这不是已退役。只有正常注销回执确认 `UNREGISTERED` 后才成为不可归档重试的 `phase: FAILED` / `authority-retired` 历史记录。若注销明确 `FAILED` 且 worker 已确认停止，管理员可在完全相同请求中另加 `retryKey: <新固定UUID>` 明确重试这一注销步骤；新 attempt 在派发前落盘，回包丢失沿用该 retryKey。`UNKNOWN`、仍运行、换旧 key 或换 replacement 都不能重试删除。

发布此接口须先部署匹配的 `dataset-cache.py`、`storage-authority.py`、`storage-retirement.py`、`storage-archive.py`、`node-executor.py` 和 runtime 清单，再发布门户 `storage-archive.mjs` / `execution.mjs`。已有私有 `storage.archive.retire` RPC 复用，不新增公开 peer 写入口或 VPS worker 权限。源节点常驻 transfer-peer 持有旧模块实例：必须确认无活动传输/恢复/认证 worker 后，逐节点更新常驻服务并验证带认证的 `retirement-guard` 能力；仅替换磁盘上的 Python 文件不算完成。旧 peer 不提供该能力时操作拒绝，保护不变。不能在旧消费者仍运行时启用退役。

回滚前先禁止新的退役请求。若已写入任何 source/target tombstone，必须保留识别这些围栏的新 native 代码及所有退役 journal；不能回滚到会忽略围栏的旧 peer，也不能删除 tombstone 或把旧数据重新登记来“恢复”。门户可停用新入口，未完成的同一意图保留待人工核验，正常数据和训练服务无需重启。

## 管理员手动缓存标记

`datasets.storage.status` 可带 `{machine,dataset,version,pinId}` 查询精确标记，必须同时给完整版本；返回 `version.manualPinProtocol:1` 和 `version.manualPin:{pinId,owner,present}`。`owner` 由当前认证主体确定，不能从浏览器传入。查询不创建标记；其他账号的标记和 `authority-` 标记拒绝访问。`pin/unpin` 在节点锁内再次核验归属，不因调用者是管理员就删除他人的标记。

前端按账号、机器、物理数据集名及完整版本持久保存操作身份；回包丢失后只读核对原 `pinId`，不重新生成 UUID。节点未提供精确能力或查询未知时禁用相应写操作，总 `pinCount` 不是本人标记的证明。预算查询只在数据集页展开或明确刷新时发起，不随全站状态刷新轮询。

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


## 版本删除（PR-N，节点与门户分阶段发布）

- `datasets.unregister {machine,dataset,version?}`：新节点校验个人来源和最后副本；成员必须指定完整 version，旧/共享/来源不明仅管理员。管理员在新旧节点上都复用 PR-M2 的 `createDatasetRemovalGuard(service,principal).withProtectedRemoval(...)`：跨机器 dataset/version 锁覆盖实时核验和 bridge 派发，必须证明另有完整副本，否则409 `LAST_COPY_UNPROVEN`。旧能力仅管理员可用，请求形状仍为 `{...reference,userId,hostAdmin:true}`；cap1 加私有 `protocol:'dataset-delete-node-v1'`，管理员另带守卫实际证明的完整版本集合 `portalProvedOtherCopy`。节点只对 hostAdmin 接受这份精确证明，版本不在集合中、租约、pin、数据库原件均拒绝；旧 executor/worker 拒绝 v1 请求和任务类型，能力读取之后回滚也不能执行旧清除。客户端不能传协议或证明。已派发或未知目标排除及解除规则完全沿用 M2，见 [DATASETS.md「管理员：清缓存与注销登记」](DATASETS.md#管理员清缓存与注销登记)。门户围栏在车道之前检查；车道内再次出现明确零派发拒绝时，只清本次 request_id 的空编号排除。能力或清单查询失败不能证明不存在。
- `datasets.delete {dataset,version,key}`：key 为 UUID；客户端不传 machine、owner、角色、依赖或期限。服务从完整可信节点清单、可信副本/归档记录及实际 authority grant 枚举所有物理名称。所有节点 cap1 后先持久化任务/子 UUID；所有计划均确认调用者权限后，原子建立门户围栏，再派发节点围栏。节点写入之前 BLOCKED 原子释放本任务的门户围栏。相同 key 不重复执行。零授权、跨账号、旧能力、未知依赖均拒绝/停止。
- `datasets.delete.status {key}` **或** `{operationId}`：只查询固定原节点编号，可补确认迟到回执，永不派发下一步。查询维护期间可用。返回 `operationId,key,dataset,version,state,steps,events,createdAt,updatedAt,retainUntil?`；不返回 owner ID、路径、inode、grant/token 或私有证明。状态 `PLANNED/RUNNING/REMOVING_CACHES/RETIRING_ORIGINAL/DELETED/BLOCKED/FAILED/UNKNOWN/WAITING_CONTINUE/CANCELING/CANCELED`。`DELETED` 严格要求每个物理命名空间的当前本代次 `ISOLATED` 回执和至少一份完整数据保留；期限后允许实际固定 `PURGED` 回执，步骤据实显示。历史 phase 文件不能代替当前回执；实际恢复转 `BLOCKED` 并确认对应步骤 `RESTORED`，离线/缺失/错代次转 `UNKNOWN`，不接受外部 `REVOKED/RETIRED` 代替。
- `datasets.delete.restore {operationId,machine}`：仅管理员（CLI 或网页确认后），完整可信清单先重查 cap1。恢复原源时，同一任务全部步骤一起恢复；完整/被驱逐副本还原登记和实际保留数据，PURGED 副本凭精确源恢复回执释放围栏，不声称已清除的字节又存在。尚未清除但已到期的副本也仅在固定原源已恢复后才能还原。返回 `RESTORED`、明确拒绝的 `FAILED` 或 `UNKNOWN`；失败的固定恢复阶段可按下面的管理员重试规则重试，已确认成功只查询。普通到期恢复、占名或证据不明失败关闭。网页入口绑定任务中已确认的完整保留副本，未知回执只查询原任务。
- `datasets.delete.continue {operationId}`：仅管理员。沿用原发起人的身份、角色和当前授权；原403拒绝任务不可升级成管理员删除，管理员必须自己新建任务。先查原编号，只有原阶段 FAILED 或无结果且 systemd 明确 STOPPED，才可显式重派同一固定阶段；请求使用新的私有 attempt key 去重，节点保存每次尝试和原失败回执，journal 续做原事务。RUNNING/UNKNOWN 不重派，成功阶段不重派。恢复、取消或重新登记过的任务不能继续删除。门户重启后未完成推进显示 `WAITING_CONTINUE`、“等待继续（门户已重启）”及 `canContinue:true`；查询本身不启动任何步骤。
- `datasets.delete.cancel {operationId}`：仅管理员，维护期也可用。停止门户推进并确认旧 worker STOPPED；没有 journal 或确无移动的步骤直接解除围栏，部分移动只按固定 inode 回滚，完整隔离恢复。取消永远不调用 isolate、不继续撤销 grant；已撤销授权保持撤销，数据使用新登记。取消 FAILED 后可显式重试原 cancel 阶段，条件同上。`CANCELED` 转换、查询及重复取消都幂等修补门户围栏，避免最后回执与门户重启间留下残留。结果 `CANCELING/CANCELED/FAILED/UNKNOWN`，未知终止状态仍拒绝。
- `datasets.delete.registration.discard {operationId,machine,key,dataset?}`：管理员 CLI 专用，完整清单 cap1 门控。dataset 缺省使用任务名称；若指定则只能匹配任务在该机器的固定物理步骤，不接受路径、owner、角色或代次覆盖。固定 key 与审计在私有 RPC 前持久化，成功返回 `DISCARDED`，回执未知为 `UNKNOWN`，只允许显式沿用同一 key 续做元数据撤回。节点从子 operationId 推导数据和版本，只在当前 PURGED 代次、准备 inode 从未安装且无活数据/保护时移动意图到私有审计区。不会删除载荷或解除墓碑；成员、旧能力、错误绑定或审计失败均零派发。
- `datasets.catalog/capacity`：`datasetDelete:1` 仅在完整可信清单每个节点的私有能力回执全部确认后投影；否则 0。新节点 list 提供安全的 `deletionPermissions`，`memberAllowed:false` 时界面隐藏成员删除，并在 ⓘ 中提示“这份数据只能由管理员删除”；旧节点缺字段按不可用处理，不从 owners 猜权限。
- 私有桥 `storage.dataset-delete.{capabilities,locations,registration,registration-discard,plan,fence,isolate,status,restore,release-absence,cancel,commit}` 不接受公共/peer/upload ticket 请求。UID/hostAdmin 来自当前登录身份。限额退役 worker 没有24小时 RuntimeMaxSec；普通 dataset worker 原限时保持。phase launch 固定且先持久化，管理员重试用私有 retryKey 保存 attempt 审计，绝不改变目标、原身份或恢复源。节点先读 systemd 活动再读结果；`stoppedPhases` 明确列出已停止阶段，`runningPhases` 即使回执已落盘也保留实际仍运行的 worker；门户继续/恢复/取消仍先等待它退出。RUNNING 查询不等待载荷锁。`registration` 只读新登记证明；清除后由有权用户显式重新上传/工作区发布或管理员本机重新登记才创建新的 inode 和来源，旧后台导入、prepare、复制、归档不能越过 PURGED 墓碑。门户仅匹配原节点任务/快照/代次和当前账号权限后解除这个位置的旧围栏。其他位置需要管理员对原任务的完整新源执行 restore 来恢复或释放；新源未 READY、证明改变或权限改变均拒绝。旧 grant/token 永久不复活。

DELETED 只覆盖当前逻辑版本及固定授权依赖；其他名称下的副本不受影响（transfers 产生的独立副本）。已登记但被驱逐的步骤和空命名空间，恢复原完整来源后都释放本任务墓碑。RESTORING 可在截止后完成；全任务隔离确认才为节点到期清理提交许可，部分任务不因7天到期丢恢复材料。物理清除还要求内核 NTP 已同步（STA_UNSYNC 未置位），墙钟过期单独不足；本实现不采用单调时长替代。跨节点最低保留截止允许5分钟时差，否则显示待确认并保留继续/取消出口。

第四轮恢复边界：已完成的隔离 journal 只补投影后恢复，取消不再次隔离；首次回滚保留个人来源证明。正在运行的原 worker 保持“仍在进行”的等待，`canContinue:false`；CANCELING 不允许继续。终态门户墓碑只拦精确版本的后台重建，不永久阻断整数据集的普通注销。未提交收集许可的完整 peer 可从保留字节恢复，缺失或损坏的提交回执不能被推断为未提交。

外部替代退役不被重写：其锁、权限、永久 reference/grant fence 和 API 契约原样保留。本功能仅处理没有替代的版本删除；外部严格完整替代证明只是普通注销“不是最后一份”的实际可重建依据，并在日志单独标为“外部替代退役”。来源不明单 owner 仅管理员。保留期间计费不因目录移动释放；到期清理仅接原本明确启用的 storage 收集服务，本 PR 不开 timer、不部署节点。前端由后续 m4 接口整合。
