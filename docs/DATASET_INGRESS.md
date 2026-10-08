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

本期只有**单个明确配置的固定仓库**，不宣称自动在多个机械盘之间均衡。仓库未确认
可用或剩余空间不足时拒绝上传，不自动降级到固态。个人工作区、`data put` / `publish`、
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
   `dataset-ingress-node.py` 与 `node-executor.py`；私有 `storage.upload.locate` 只读
   固定 owner/UUID 会话头，不对公网、peer 或用户 CLI 开放。
2. 发布匹配的执行桥（只加上述私有 RPC 白名单）、Portal、网页上传模块并构建 CLI。
   Docker 镜像必须包含 `dataset-ingress.mjs`。默认仍为关闭。
3. 重新核实仓库真实挂载与容量。节点须启用原有固定 `storageArchive` / `storageAuthority`，
   它本身为 authority 源节点且不是 SSD tier 缓存节点；保持原 `datasets.root` 不变。
4. 用私有、管理员维护的 JSON 文件配置 `enabled:true,machine:WAREHOUSE_ID,authority:AUTHORITY_ID`，
   设置 Portal 的 `GPUQ_DATASET_INGRESS_CONFIG` 指向该文件。所选仓库必须和原有
   `GPUQ_STORAGE_ARCHIVE_CONFIG` 的固定机器及 authority 完全一致；不要向旧归档配置
   增加新键。配置示例中的 ID 均应替换为实际值，不提交内部配置或凭据。
5. 验收：仅有训练目标权限的成员上传、实际机械盘路径与字节计数、READY 全量校验、
   续传/丢失 ACK、独立取消与票据撤销、其他账号拒绝、原 SSD 会话续传、目标准备的
   容量拒绝、断网拒绝、数据库重启与关闭策略恢复。软件夹具测试不能代替实机介质、
   网络和训练准备验收。

### 前端兼容契约

认证状态的 `datasetUploadAdmission` 包含
`{protocol:1,available:boolean,targetMachine:string|null}`。`targetMachine` 是当前受信策略
固定的新上传仓库，不是用户所选训练机；策略关闭或目标未确认时为 null。
它只用于显示上传位置，不证明节点在线、容量充足或账号可写；实际准入仍逐次核验。

`begin/status/seal/commit/discard/direct-ticket/direct-revoke` 的 placement-aware 回包
含 `placementProtocol:1,requestedMachine,storageMachine,storageTier,legacyPlacement`。
`storageTier` 为 `hdd` 或 `existing`；后者表示沿用启用策略之前的会话，不推断其介质。

新客户端在已有 placement-aware 会话后调用 `datasets.upload.routes {machine,uploadId}`。
`machine` 仍为原训练选择，节点回包中的 `machine` 为真正的上传节点；匿名探测及签发
票据必须核对它。Portal 去掉 `uploadId` 后转发旧节点 routes 协议，不修改节点票据内容。
无会话的 routes 只做入口预览，不建立位置记录，也不能用于重绑旧会话。

`datasets.catalog` 仍是目录元数据。READY 入库位置可以显示“本人可用”，但没有该机
训练授权时 `canPrepare` 仍为 false；准备另一台训练机器走现有固定版本复制流程。
