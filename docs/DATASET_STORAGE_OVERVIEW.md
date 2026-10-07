# 仓库与缓存只读总览

这是源码候选契约，**不是生产部署回执**。门户和配套节点 helper 都安装后，才会返回完整的仓库物理容量。旧节点仍可显示原有缓存卷容量，但仓库信息保持未知，不拿固态容量冒充仓库容量。

## 调用与权限

已认证 `POST /api/call`：

```json
{"operation":"datasets.overview","args":{}}
```

所有启用账号均可读取目录与容量摘要，包括尚无机器额度的新账号。身份、角色、宿主路径及机器参数都不接受；额外字段返回 400。门户仅使用固定的节点 `datasets.list` 与 `datasets.capacity` 元数据读取，能力与 `canUse/canPrepare` 仍由原账号授权判定。中途撤权时丢弃整份响应。

响应为 `{result,principal}`，不附完整仪表盘 `state`，走已有的独立数据读取通道，不进入调度／账号写队列。最多 4 个并发数据读取请求；超过返回 429。不自动轮询，页面打开或用户刷新时查询即可。

本接口不授予文件预览、下载、终端、复制或删除权限。当前 `filePreviewAvailable:false`：这里的「预览」只是登记名称、版本、所属用户、大小和位置；不要据此渲染可点击的私人文件树。既有上传、准备、租约、复制、释放和删除仍使用各自接口与原权限围栏。

## 响应字段

顶层：

| 字段 | 意义 |
| --- | --- |
| `protocol` | 固定 `dataset-storage-overview-v1` |
| `checkedAt` | 门户完成此次观察的 UTC ISO 时间 |
| `partial` | 至少一台目录／容量读取失败、旧节点缺少仓库事实，或仓库卷无法确认 |
| `filePreviewAvailable` | 当前固定 `false`；元数据浏览不是文件授权 |
| `physicalVolumes` | 以 `machine + opaque device ID` 去重的物理文件系统快照；不含宿主路径 |
| `warehouse` | 仓库原件汇总，见下表 |
| `caches` | 每台训练机器的本地缓存与其真实卷容量 |
| `datasets` | 现有目录的仓库优先投影；不是第二套登记表 |

`warehouse`：

| 字段 | 意义 |
| --- | --- |
| `state` | `READY`：容量与原件统计完整；`NOT_CONFIGURED`：所有新节点确认未配置仓库；`UNKNOWN`：尚不能确认完整事实 |
| `volumes` | 每个已配置仓库的 `{machine,state,volume,originalContentBytes,datasetCount,versionCount,usageComplete,warnings}` |
| `originalContentBytes` | 已发布仓库原件的逻辑文件字节合计，同一登记名＋不可变版本跨仓库只算一次；不完整时为 `null` |
| `datasetCount/versionCount` | 已发布原件的去重计数；不完整时为 `null` |
| `warnings` | 固定诊断码；不返回原始节点异常或内部路径 |

每个 `caches[]` 为 `{machine,state,volume,readyContentBytes,readyVersionCount,budgetBytes,reserveBytes,usageComplete}`：

- `state` 为 `READY/UNKNOWN/UNAVAILABLE`，表示容量读取状态，不代表 GPU 或作业状态。
- `readyContentBytes` 是该机器已 READY 的登记副本的**逻辑文件大小**；不是整个固态的用量，也不是分配块数、在途预留量或硬盘实占。缺少大小或目录不可读时为 `null`。
- `budgetBytes` 是既有数据缓存预算；未配置或不能确认时为 `null`。不是个人容量上限，不是整块固态容量。
- `reserveBytes` 是该卷既有安全预留；不要与仓库容量相加，也不要作为个人限额。
- `usageComplete` 仅说明已发布目录统计是否完整。它不提供未来上传可用空间／准入证明。

`volume` 为：

```json
{
  "id":"SERVER_ID:OPAQUE_DEVICE_SHA256",
  "state":"READY",
  "checkedAt":"2026-01-01T00:00:00Z",
  "totalBytes":1000,
  "usedBytes":300,
  "availableBytes":650,
  "reserveBytes":50,
  "usableBytes":600,
  "readOnly":false,
  "guarded":true
}
```

- `usedBytes` 来自文件系统快照，包含工作区、缓存、系统服务等同卷内容；不能把它显示为「数据集占用」。`availableBytes` 是服务账号可用的文件系统空间，可能受文件系统预留影响，不等于 `totalBytes-usedBytes`。
- `usableBytes=max(0,availableBytes-reserveBytes)` 是容量观察，不考虑全部在途预留，不可作为上传必然成功的保证。
- 节点身份只用于同一节点的设备／bind alias 去重。不能据此推断硬盘类型、跨机器 NAS 共盘或把不同机器的容量当作一个统一可分配池。
- `UNKNOWN` 的容量数值、ID、时间均为 `null`，不能显示为 0 或「空闲」。旧节点可能有可读的容量但 `id/checkedAt/readOnly` 未知。
- `guarded` 仅说明节点按受管挂载配置提供观察；不是文件授权，也不是写入成功证明。

`datasets[]` 为 `{dataset,displayName?,versions:[...]}`；版本为：

```json
{
  "version":"IMMUTABLE_VERSION_SHA256",
  "ownerLabel":"所属用户：示例用户",
  "contentBytes":42,
  "fileCount":2,
  "canUse":true,
  "originals":[{"machine":"WAREHOUSE_ID","dataset":"sample","state":"READY","canUse":true}],
  "caches":[{"machine":"TRAINING_ID","dataset":"sample","state":"READY","canUse":true,"canPrepare":false}]
}
```

原件位置只接受节点明确的 `warehouseReady` 事实：`READY/NOT_READY`；没有明确证据时不推测这台机器是仓库。缓存的 `REGISTERED`＋仓库原件 READY 显示 `NOT_LOCAL`；原件 READY 永远不等于训练缓存 READY。各位置的 `dataset` 是其精确登记引用，可能与显示名不同，也可能是仓库绑定的实体缓存名；不是文件路径。复制／释放必须继续使用原接口的精确版本与授权校验。

`contentBytes/fileCount` 是各副本一致且完整时的元数据值；缺失或冲突为 `null`。显示所属用户只使用现有账号映射，不向前端泄漏 owner ID、认证数据、下载票据、源路径或原始清单。

## 告警与安全边界

可选个人双盘布局的固定版本带 `personalOriginals`，只描述精确本机可读取的位置和 `storageTier`；保留普通目录／训练选择，不计入管理仓库原件或中央缓存卷的逻辑字节。它们不是可释放缓存，也不构成仓库备份证明。个人盘容量另用 `gpuctl storage info`，不以中央卷快照代替。

| 固定码 | 展示意义 |
| --- | --- |
| `WAREHOUSE_USAGE_HIGH` | 仓库文件系统用量达到 90%，应提醒管理员 |
| `WAREHOUSE_FREE_SPACE_LOW` | 仓库可用空间不高于既有安全预留 |
| `WAREHOUSE_READ_ONLY` | 读取到只读文件系统 |
| `WAREHOUSE_CAPACITY_UNKNOWN` | 配置的仓库卷容量暂时不能确认 |
| `WAREHOUSE_FACTS_UNAVAILABLE` | 节点旧版本、失联或未返回可信仓库角色事实 |
| `CACHE_WAREHOUSE_SHARED_VOLUME` | 两种角色回报同一设备；不得重复叠加容量 |

上述阈值仅用于告警，不新增仓库或个人硬容量限额。本变更不调整配置、上传准入、缓存预算、活跃租约、回收 pins、固定权威原件或迁移围栏；实际 ENOSPC、挂载失效、只读盘及原有写保护仍照常拒绝危险操作。

## 配套与验收

- 配套节点 `datasets.capacity` 增加 `storageOverview.protocol:"dataset-storage-node-v1"`，含独立 `cache.volume/budgetBytes` 与实际配置的 `warehouse.volume`。容量读取常数时间，不扫描 payload 或完整清单，不创建第二登记表。
- 门户新文件 `dataset-storage-overview.mjs`、读取路由、维护期只读 allow-list 和运行镜像 COPY 必须一起安装。
- 修改节点执行器会改变其 SHA；正在迁移的环境须由维护负责人先协调固定 SHA／root pin，再部署，不能绕过迁移围栏。
- 测试：`node --test tests/dataset-storage-overview.test.js tests/dataset-catalog-visibility.test.js tests/dataset-storage-overview-http.test.js`；Python 3.12：`TMPDIR=/private/tmp python3.12 tests/storage-capacity-overview.test.py`。生产验收另看真实节点的完整协议、物理卷和容量快照；本地 fixture 不证明上线。
