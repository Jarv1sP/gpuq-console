# 数据集先入机械仓库

这是独立、默认关闭的上传准入能力。它复用现有版本、清单、短期票据、断点和发布校验，
不新增传输工具或用户命令。合并源码不代表已经启用；须完成下面的部署与实机验收。

## 数据路径

用户仍选择有使用权限的**训练服务器**，执行 `gpuctl data upload DIRECTORY --name NAME`，
或使用网页目录上传。管理员启用本策略后，新上传直接写入一个已核实的机械仓库，
包括清单、暂存文件与最终版本；不会先在所选服务器的固态落一份再复制归档。

完成回包分别给出 `requestedMachine`（原训练选择）、`storageMachine`（实际仓库）和
`storageTier:"hdd"`。续传和取消仍沿用原训练选择与原上传编号。需要训练时，现有
`data prepare` 按固定版本将数据准备到有权限的目标机器；是否允许占用固态由节点的
容量与预留空间策略决定。上传成功不表示已经占用目标固态，也不表示版本可立即训练。

默认沿用**单个明确配置的固定仓库**。管理员也可配置一个小型仓库池，第一次准入按
配置顺序选择已确认可写、实际空间足够的仓库；这不是自动复制、负载均衡或用户选盘。
仓库未确认可用或剩余空间不足时拒绝上传，不自动降级到缓存。个人工作区、`data put` / `publish`、
旧 import 及已有 managed transfer 保持原机制，不属于这项新目录上传路径承诺。

## 兼容与权限

- Portal 在派发第一次节点准入前保存 `dataset_upload_placements`，固定 owner、上传
  UUID、原训练选择、完整清单规格和实际存储节点。丢失回包或重启不会改换存储节点。
- 第一次准入只读核对各已配置节点上的精确 owner/UUID。旧会话继续原节点；多节点
  重复、身份冲突或查询失败均拒绝，不把网络超时当作“不存在”。
- 策略关闭后，已绑定会话仍在原存储节点续传；不能删除位置表来回滚。尚未登记的
  新上传恢复旧路径；已登记但位置未确认的上传拒绝派发，须管理员核对，不能静默
  改写到固态。旧归档策略哈希、归档日志和 transfer digest 不改。
- 训练机器授权在每次控制请求以及节点响应后核验。上传到仓库不授予仓库 GPU、
  SSH、终端或宿主权限。只有确认 READY 的精确 owner/dataset/version 可以作为
  本人的跨机数据来源；旁观其他人的目录不建立读取权限。
- 直传仍使用实际仓库的 HTTPS 入口与票据。客户端按 `storageMachine` 验证节点，
  不能把训练节点名称冒充上传节点；失败也不自动改变为 VPS 中转。

## 管理员启用

1. 备份数据库及各节点源码。先在所有配置节点发布完整匹配的运行时，包含
   `dataset-ingress-node.py`、`dataset-upload.py`、`node-executor.py`、`transfer-jobs.py`、
   `training-preparation.py`、`storage-archive.py` 与 `storage-retirement.py`；私有 `storage.upload.locate` 只读
   固定 owner/UUID 会话头，不对公网、peer 或用户 CLI 开放。
2. 发布匹配的执行桥（只加上述私有 RPC 白名单）、Portal、网页上传模块并构建 CLI。
   Docker 镜像必须包含 `dataset-ingress.mjs`。默认仍为关闭。
3. 重新核实仓库真实挂载与容量。节点须启用原有固定 `storageArchive` / `storageAuthority`，
   它本身为 authority 源节点且不是 SSD tier 缓存节点；保持原 `datasets.root` 不变。
4. 用私有、管理员维护的 JSON 文件配置 `enabled:true,machine:WAREHOUSE_ID,authority:AUTHORITY_ID`，
   设置 Portal 的 `GPUQ_DATASET_INGRESS_CONFIG` 指向该文件。默认仓库必须和原有
   `GPUQ_STORAGE_ARCHIVE_CONFIG` 的固定机器及 authority 完全一致；不要向旧归档配置
   增加新键。配置示例中的 ID 均应替换为实际值，不提交内部配置或凭据。
5. 验收：仅有训练目标权限的成员上传、实际机械盘路径与字节计数、READY 全量校验、
   续传/丢失 ACK、独立取消与票据撤销、其他账号拒绝、原 SSD 会话续传、目标准备的
   容量拒绝、断网拒绝、数据库重启与关闭策略恢复。软件夹具测试不能代替实机介质、
   网络和训练准备验收。

### 可选仓库池：只选择新上传，不迁移旧数据

在同一个私有上传策略中增加 `warehouses`，最多 4 项。每项使用不同的服务器 ID 和
authority ID，且必须包含原先的默认仓库。下面仅为公开示例：

```json
{
  "enabled": true,
  "machine": "gpu-1",
  "authority": "archive-a",
  "warehouses": [
    {"machine": "gpu-1", "authority": "archive-a"},
    {"machine": "gpu-4", "authority": "archive-b"}
  ]
}
```

节点分别保留自己的本地 `storageArchive` 与 `storageAuthority`。训练节点在
`storageAuthorities` 中显式配置每个 authority 的固定机器及对应受信 transfer peer。
原 authority ID 不能改指向另一台机器；旧恢复收据、pin 和归档日志不重新解释。
修改策略前须先验证匹配运行时、真实挂载、直传入口和节点间复制。

1. 首次新上传按完整清单预检，所需空间为
   `totalBytes + manifestBytes × 4 + entries × 8192 + 65536`，并检查 `entries + 16`
   个 inode。核算包含现存预约及文件系统安全预留，不只是文件大小。
   容量告警线不阻断，也不新增个人配额；无法确认、不可写或实际不足才不能选中。
2. 首个合格仓库确定后，Portal 原子保存 intent、服务端 UUID、完整清单及固定
   warehouse / authority / policyKey，再允许字节写入。begin 仍重新核验容量。
   并发上传可能使容量变化，此时保留原上传报错，不换仓、换 UUID 或回退 VPS/缓存。
3. 重启、丢失回包、续传和取消均沿用原位置。删除池成员会阻止其尚未派发的 ISSUED
   意图；已有 BOUND 会话仍只尝试原节点。禁止删除位置表后重新分配已有上传。
   停止新入库或移除池成员不撤销已持久绑定的历史来源：BOUND 的发布/归档继续原仓，
   已认证版本的证明和别名保留；节点仍逐次检查该固定 authority、peer 和原根身份。
4. 新 READY outbox 精确匹配原 owner 和服务端上传 UUID。归档在所属仓库核验，
   不把第二仓库的数据复制回默认仓库。缓存认证绑定实际 transfer 来源及其 authority；
   证据不匹配的副本仍保持保护，不冒充可回收缓存。
5. 老单仓配置不增加预检 RPC；老上传、旧 outbox、旧归档和旧 transfer 保持原语义。
   新字段只附加到新池上传/归档 JSON，不批量改写既有表、记录或 pins。回退前停止
   新准入，保留位置表和新来源 journal；不能靠删除 journal 退回旧版。

### 从仓库准备到训练缓存

手动 `data prepare` 和自动训练准备复用现有固定版本 transfer。对配置了独立仓库与
缓存根的目标节点，新建的受信仓库复制由服务器在原 transfer journal 中写入
`targetStorage`，固定目标机器、缓存根、目录身份及挂载身份，并纳入原 spec digest。
这是内部绑定，不是网页、CLI 或 peer 可填写的新参数；没有新增队列或传输入口。

后续写入、校验、续传和训练容量抵扣使用同一绑定。根目录或卷身份变化就拒绝，不把
同一次复制换到仓库或新目录。归档的 `archiveLane` 始终沿用仓库路径；没有新字段的旧
transfer 继续其原路径，不能在续传时自动改根。目标只有一个数据根时保持原行为。
有尚未结束的 `targetStorage` 作业时，不得回滚到不识别该字段的旧执行器：先停止新
派发，保留兼容运行时处理原作业，不能删除或剥去绑定字段来恢复运行。

与训练项目复制组合发布时，必须同时保留原私有项目准备上下文、校园物理路线检查
和单次 worker 入口。项目复制的 journal 与数据集的 `targetStorage` 不互相替代；
不能用只包含其中一项的旧运行时接管另一项已绑定的准备。执行桥配套属于独立发布
步骤，源码具备操作不等于默认桥已经开放，不能通过放宽通配 RPC 来补齐。

首次准备若目录选中的是已认证缓存，Portal 从精确 owner/机器/物理版本对应的
`ARCHIVED` 记录解析原仓库，固定从原仓库复制，不再增加一跳训练缓存中转。已有
transfer 的来源不重选。没有原仓证明时不推测其 authority；新的非仓库来源复制到
双根目标会在派发前明确拒绝，不静默写入仓库，也不放宽为任意受信 peer 可写缓存。

容量不足或仓库离线导致首次准入未建立时，界面保留具体原因。只有受认证 Portal
返回原 intent 的 `404 / DATASET_ADMISSION_ABSENT`（且没有同 intent 的在途准入），
**下一次用户显式发起同规格上传**才允许用相同 intent key 再次 create。
本次失败不立即重发，普通网关 404、超时和未知结果都不授权重试；已有 uploadId/BOUND
只查询、续传原会话，不重新分配。网页与 CLI 共用同一恢复规则。

预检复用私有 `storage.upload.locate`，仅增加成对的 `specification`、`authority` 参数。
它不创建工作区、上传或预约，不对外开放。未支持预检的节点不会被选中；文件监听器、
直传票据及 forced executor 的 RPC 名单不变。

### 前端兼容契约

认证状态的 `datasetUploadAdmission` 包含
`{protocol:1,available:boolean,targetMachine:string|null}`。`targetMachine` 是当前受信策略
默认的新上传仓库预览，不是用户所选训练机；策略关闭或目标未确认时为 null。
它只用于显示上传位置，不证明节点在线、容量充足或账号可写；实际准入仍逐次核验。
启用池时，实际位置以 admission 及后续回包中的 `storageMachine` 为准，不能用预览
字段签票、创建工作区或指定字节目的地。

`begin/status/seal/commit/discard/direct-ticket/direct-revoke` 的 placement-aware 回包
含 `placementProtocol:1,requestedMachine,storageMachine,storageTier,legacyPlacement`。
`storageTier` 为 `hdd` 或 `existing`；后者表示沿用启用策略之前的会话，不推断其介质。

新客户端在已有 placement-aware 会话后调用 `datasets.upload.routes {machine,uploadId}`。
`machine` 仍为原训练选择，节点回包中的 `machine` 为真正的上传节点；匿名探测及签发
票据必须核对它。Portal 去掉 `uploadId` 后转发旧节点 routes 协议，不修改节点票据内容。
无会话的 routes 只做入口预览，不建立位置记录，也不能用于重绑旧会话。

`datasets.catalog` 仍是目录元数据。READY 入库位置可以显示“本人可用”，但没有该机
训练授权时 `canPrepare` 仍为 false；准备另一台训练机器走现有固定版本复制流程。
