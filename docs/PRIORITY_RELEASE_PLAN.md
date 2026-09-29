# 待发布优先级功能：最小核心合并计划

本文件是发布计划，不表示已部署。已获准只读核对四台节点的 GPUQ `__init__.py`、`__main__.py`、`fleet.py`、`sync.py`；同名线上文件在四台一致。前两项与本地 HEAD 一致。线上 fleet/sync 仍配套使用既有节点默认路径；本地 HEAD 已改为显式路径和更严格的同步校验，这不是本次优先级功能必需的变化。

本次最小发布应在私有构建目录保留批准读取的线上四文件，仅给线上 `fleet.ALLOWED` 增加 `set-priority`；再叠加已审查的优先级核心模块与测试。不要把公开源码回写成线上旧版本，不要将本地整包直接覆盖线上，也不要混配依赖 `fleet.host_paths` 的新 sync 与旧 fleet。该内存覆盖组合已通过 51 项优先级回归；发布前仍需重建、核对差异 / SHA、备份及数据库兼容核验。

后续独立升级通用 fleet/sync 时，应先确认每个 inventory 都显式配置正确的 binary/config，再采用服务端先、客户端后的兼容顺序。线上既有默认路径是兼容性约束，不是要撤回公开版本安全校验的理由。daemon 的停止路径不会主动停止独立 job unit，但发布前仍须核对生产 unit 的依赖和停止策略；无 Python 热重载接口，任何调度器管理动作另行确认，不与资源 runner 发版混为一步。

## 独立包边界

公开源码补丁以已发布 P0 为基线，只加入优先级、管理员非交互命令、真实 GPU 租约历史及对应后端测试。项目环境、网络助手、社区和界面由各自独立补丁交付。不要将混合工作树整体打包。安装器保留 `common-p0` / `ray-p0` 双档；优先级升级不修改 runner、CPU 委派、用户管理器或 node-config，也不改变既有训练预算。

生产核心私有包保留上述四个兼容文件，记录全部成员 SHA。核心升级与管理员命令可分别部署：管理员功能只需节点 helper/固定无参数 sudo 入口、node-executor、VPS bridge/API 和客户端，不要求重启 GPUQ。默认可信 ROOT 能力不套用训练 CPU/内存/PID 上限；每节点最多 4 个命令、显式超时、有限输出和仅 owner 取消用于防误操作，不是安全沙箱。旧 helper 若曾被单独使用，先核验未纳入槽位的活动命令，不假定并发状态为空。

## Schema 9 → 10 → 11

schema 10 只给 `jobs` 增加默认 false 的 `preempt_idle_only`。新请求和被让位任务都须明确选择该范围；旧 P0/now/never 不会自动纳入。idle 为 P0/now/never，normal 为 P2/never/never，high 为 P4/never/never；均为 queue。最低让位后结束，保留已写结果，不自动重排。仅 PENDING、无活动 attempt/lease/抢占/扩缩计划的任务允许 CAS 调档。

schema 11 新增独立 `gpu_allocation_history` 表。在发放/释放 leases 的同一事务中记录真实 GPU UUID、当时卡号、job/attempt、acquired_at、released_at、已知原因。发放重试、心跳和未释放的令牌轮换不制造新分配。迁移只将**仍活动的** lease 按原 acquired_at 回填，source=migrated_active、released_at=null；旧已释放的卡没有历史，不用 attempt 时间推断。新间隔 source=observed。这是调度租约时间，不保证等于 CUDA 开始/停止时间。

`show` 默认返回最新 256 条，明确 truncated/next cursor；CLI 可用 `--history-before-id` / `--history-limit` 翻页。诊断只映射白名单字段，按 job 绑定；旧 daemon 无历史能力则明确 unavailable，不填假时间。

`_init` 必须以原服务 UID 使用原配置，获取原 `daemon.lock` 后才执行；daemon 活着时拒绝迁移。`Store.initialize` 在单个 BEGIN EXCLUSIVE 事务内校验旧 schema、执行两个迁移、校验新 schema 并提交；事务内任一失败回滚全部 DDL/数据。事务提交后的 integrity/WAL/权限检查可能失败，不能仅凭命令失败推断数据库仍是 v9，必须读取实际版本。daemon 启动不自动迁移或修复数据库。

## 停顿与恢复

没有热重载，必须短暂停止并重新启动 **gpuq.service 本身**。已核验的生产作业为 app.slice 下独立兄弟 unit，其实际进程 cgroup 不属于 gpuq.service；没有 PartOf/BindsTo 停止传播关系。旧 daemon 的 SIGTERM 只请求退出、等待线程、关闭 RPC/数据库/锁，不停止 job unit。KillMode=control-group 只覆盖其自身控制组。但这不等于任意节点可无审批升级：RPC、状态核对、取消和新调度会暂不可用，任务可能在间隙自行结束，必须逐节点核验恢复。

1. 先在空闲 canary 验证；重新读取服务 identity、实际 cgroup、GPU 进程、活动 attempts/leases/actions。忙节点须单独批准，不能用 CPU 委派批准替代调度升级批准，反之亦然。
2. 保存有效 observe_only（DB setting 优先于配置）、配置/旧包 SHA、所有活动 unit 的 PID/InvocationID、旧表摘要。暂停新请求入口，并通过原 GPUQ `set-mode --observe-only` 暂停新调度，不改配置文件。observe-only **仍执行恢复/对账/已有 actions**，不是冻结；等待没有未完成 start/preempt/scale action，不能强制结束旧实验以取得空闲。
3. 正常 stop gpuq.service，等待 daemon 锁真正释放。持相同锁完成 SQLite backup（不是只复制主 DB、遗漏 WAL）、integrity_check、旧行摘要，使用候选代码执行同事务迁移。禁止 unlink/替换 daemon.lock 或在旧 daemon 活着时另开迁移器。
4. 原子替换已核验候选包，原 unit/原配置启动。等待至少两次成功恢复扫描、health=ok，并核对原 attempt/lease 身份、兄弟 unit PID/InvocationID 和外部 GPU 进程；不得生成重复 attempt 或接管未知进程。恢复原**有效**模式，而不是配置默认值。只有新 daemon 同时公布两个优先级 capability 时开启入口。
5. 迁移未提交可恢复旧包后用旧库启动；迁移已提交则旧 v9 代码不能读 v11。不可直接回灌旧 DB 覆盖期间真实进度。采用 v11 兼容的前向修复或安全回退包，保留 observe-only 与界面能力关闭；确认没有任何任务/数据库进度后才可另行批准恢复快照。

验收须只用新建的本人短任务：FIFO、PENDING CAS 调档、旧任务不被纳入、idle 让位结束并保留输出、GPU 真释放后才启动后继、租约历史时间和 owner 隔离。不能在他人当前实验上试验抢占。所有状态与记录完成后才宣称该节点已升级；忙节点可继续旧能力，门户按节点降级。
