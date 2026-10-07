# 手动服务器缓存接口

本接口只管机械仓库固定版本的服务器训练缓存。界面先展示仓库数据，再选择获授权的目标服务器；用户不选择磁盘、路径、物理缓存名或来源。复制保留原件。释放不注销数据集，不删除个人项目、开发草稿、结果或仓库原件。

## 公共契约

| 方法 | 请求 | 用途 |
| --- | --- | --- |
| `datasets.cache.capabilities` | `{machine,dataset,version}` | 当前登录、目标授权和数据读取权限核验；按节点协议决定动作可用性 |
| `datasets.cache.prepare` | `{machine,dataset,version,key}` | 缓存到服务器；完整 SHA256 版本、UUID key；不传 owner/source/path/disk |
| `datasets.cache.release` | 同 prepare | 释放该服务器的已认证缓存；保留原件及登记 |
| `datasets.cache.status` | `{operationId}` 或 `{key}` | 只读查询原操作；不启动、恢复或续做 |
| `datasets.cache.cancel` | `{operationId}` 或 `{key}` | 仅取消独立释放 worker；共享准备不能由此停止 |

能力返回 `{protocol:1,prepare:boolean,release:boolean,reason?}`。旧节点、回执未知或缺配套 helper 为 protocol 0；动作隐藏/禁用，不回退旧 unregister/evict。数据目录可见不等于可以复制其私有文件。管理员也只使用本人/已授权的数据路径，不通过本接口取得 hostAdmin。

能力还带 `prepareCancel:false,releaseCancel:true`。已有准备 worker / replica transfer 会被同账号多个动作、训练准备等消费者共用，没有消费者独占证明。本接口的准备回执始终 `canCancel:false`；明确取消返回 `CACHE_SHARED_WORKER` 提示、保留原动作状态，不调用 systemctl stop 或 transfers.cancel。独立释放 worker 绑定本 action UUID，才可安全取消。不要在前端给准备显示有效取消按钮。

操作回执包含 `operationId,key,action,machine,dataset,version,state,phase,createdAt,updatedAt,canCancel,error?,errorCode?,transferId?`；不包含内部 owner、物理绑定、路径、恢复 grant 或原件证明。

已完成的释放、取消、失败或拒绝还带 `receiptOnly:true,locationState:'NOT_OBSERVED'`：只描述原操作，不代表当前服务器仍无缓存。位置事实重新读仓库总览/节点目录。READY 每次重新观察当前精确副本，不使用这个历史标记。

状态：

- `DISPATCHING/RUNNING`：尚未完成；只展示节点已有真实阶段，没有真实计数不造百分比。
- `READY`：准备操作查询当前精确本机副本为 READY，不以历史 transfer 成功冒充现存缓存。
- `RELEASED`：worker 已移除指定认证缓存并清理隔离数据；不代表整盘空闲。
- `BLOCKED`：没有进入数据删除；如 `CACHE_NOT_CERTIFIED`（旧/唯一原件）、`CACHE_PINNED`、`CACHE_IN_USE`、`CACHE_STAGING_UNKNOWN` 或 `CACHE_AUTHORITY_UNCONFIRMED`。
- `CANCELING/CANCELED`：取消请求已持久化 / 原 worker 已确认停止且未越过删除边界。
- `FAILED`：原准备/传输明确失败；本接口不自动 resume。
- `UNKNOWN`：回执、进程或删除边界未确认。继续查原 operationId/key；不得换 UUID 自动重提。

重复 prepare/release 使用原 key 只观察原操作。同 key 更换动作、目标或完整版本为 409。取消幂等保留 READY、RELEASED 等完成事实。准备过程中失去读取授权或目标授权后，不向客户端返回旧私有结果。

## 实现与部署边界

`dataset-cache-actions.mjs` 仅持久化操作身份/control 绑定。本机准备委托已有 dataset worker；跨机准备委托已有 `dataset-replication.mjs` 与 `transfers.mjs`，状态沿原 transfer ID 查询，但不能停止其共享消费者。没有第二套复制队列、VPS 字节通路或自动重试控制器。

`deploy/dataset-cache-actions.py` 是私有节点适配器。释放必须拥有完整有效 tier recovery receipt；原件 authority guard 从源校验到目标最后检查持续持有。节点在目标 version/global 锁内再次核验 ACL、receipt、READY、pins、leases 和 staging；仅 `ready_only=True` 隔离缓存。清理在源/global 锁外进行。已进入 RELEASING/CLEANING 后被停止或报错保持 UNKNOWN，不声称数据恢复，也不覆盖原件。

同节点 HDD/SSD 采用 `storage-warehouse.py` 服务私有持久 binding 的 exact source/version/root 核对；`wc-` 前缀只是名称，不是权限或可删证明。旧未认证/未知来源副本默认保护，先走已有认证/仓库纳管，不提供“强制释放”。

发布需同时集成 Portal 路由、Docker COPY、私有执行桥 allowlist、节点 executor 路由/worker flag、runtime manifest。缺任何项时不得把源码或离线测试称为上线。中央文件集成说明见 [CACHE_ACTION_INTEGRATION.md](CACHE_ACTION_INTEGRATION.md)。不安装 timer、不修改预算/自动 GC 开关、不改路由/ACL、不中断训练。

## 验收

```sh
node --test tests/dataset-cache-actions.test.js tests/dataset-cache-actions-http.test.js
python3 tests/dataset-cache-actions.test.py
python3 tests/dataset-cache-actions-bridge.test.py
```

测试覆盖普通成员、零额度、跨账号、旧协议、审计失败、严格字段/完整版本、原 UUID、丢 ACK/重启、跨 owner 共享 worker 的固定身份、共享准备取消零派发、原件/pin/lease/staging/authority 保护、最终竞争检查、cleanup UNKNOWN、历史 READY 漂移。真实 Portal HTTP 还验收 CSRF、在途撤权、维护期只读/取消、四个并发读取准入，以及迟到 status/dispatch ACK 不覆盖已确认终态；私有桥和 executor 只派发五个精确 literal。

上线后另在获授权空闲节点验收：机械原件→缓存→独立 SHA256 回读→取得训练租约时拒绝释放→释放租约→释放缓存→机械原件继续 READY→原 key 幂等/新 prepare 从原件恢复。不得用模块加载或健康页替代此链路。
