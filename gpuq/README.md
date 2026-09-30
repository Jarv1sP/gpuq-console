# GPUQ

此目录是既有实验室 GPUQ 的完整 Python 源码，门户通过节点桥调用它，不重新实现一套与老用户竞争的队列。核心依赖 Python 标准库、Linux systemd/cgroup v2、NVIDIA 驱动与 `nvidia-smi`。

## 构建与首次安装

```sh
python3 scripts/build-gpuq.py
python3 build/gpuq.pyz --help
```

在仓库根目录运行。产物是 `build/gpuq.pyz`；固定文件时间、仅包含 `.py`，不打包数据库、配置、缓存或凭据。新机器使用 [部署手册](../docs/DEPLOYMENT.md) 的节点安装流程，生成 GPU UUID 清单、独立目录和用户 systemd 服务。已有 GPUQ 的数据库和运行状态应保留，**不要为了装门户重新初始化调度器**。

## 老用户的短命令

```sh
gpu status
gpu health
gpu submit -g 1 -- python train.py
gpu submit -g 2 -- python -m torch.distributed.run --standalone --nproc-per-node=2 train.py
gpu show J任务号
gpu logs J任务号
gpu cancel J任务号
gpu watch J任务号
gpu submit --help
```

以实际返回的任务 ID 为准；命令细节见 `--help`。`--json` 放在子命令之前。观察模式 `gpu set-mode --observe-only` 不启动新作业；验收后 `gpu set-mode --active` 允许调度。该模式保存在 GPUQ 状态库中；数据库必须备份。

**新平台普通用户使用 `gpuctl`，不直接获得共享服务账号下的 `gpu`。** 直接 GPUQ CLI 是可信旧用户/管理员的接口，不经过门户逐人权限验证；公开给普通用户会绕过门户额度。

## Console 优先级与可中断任务契约

### 独立修改排队优先级

`gpu --json set-rank JOB P0..P4` 对应 RPC `set_priority_rank`（`job_id`、`priority`、
可选完整 `expected`）。仅调整 P 值，保留 yield/restart/dispatch/checkpoint、scope 与 FIFO。
仍原子拒绝非 PENDING、活动 attempt/lease、扩缩/抢占清理及过期 expected。
节点能力 `priority-rank-v1` 标记这项合同；新版门户使用它，缺失时不回退到旧接口。
旧 `set_priority` / `set-priority` 的完整预设语义保留兼容，与此接口区分。
以下三档表格仍描述**新提交预设**，不代表独立调档会改变任务让位/恢复方式。

Console 的三档优先级复用既有 GPUQ 调度器；所有新 Console 任务额外持久化 `preempt_idle_only=true`，只允许它们中断同样带此显式标记且为 P0 / `yield_policy=now` / `restart_policy=never` 的最低任务。旧 P0/now/never 也不会被自动纳入。数据库从 v9 到 v10 只增加默认 false 的布尔列，旧任务及原策略保持不变；升级须备份并显式迁移，不重新初始化或清空数据库：

| Console 档位 | GPUQ priority | dispatch_mode | yield_policy | restart_policy |
| --- | --- | --- | --- | --- |
| 最低／可中断（idle） | 0 | queue | now | never |
| 普通（normal，默认） | 2 | queue | never | never |
| 高（high） | 4 | queue | never | never |

高优先级先排，相同优先级按持久化提交序号 FIFO 排队；高优先级不会仅因档位高就打断普通任务。最低任务必须在**新提交时显式选择可中断**。本机已接纳、输入就绪且 GPU 需求能被满足的更高优先级任务等待时，GPUQ 才会选择满足其需求所需的最小受害集合。已有空闲容量够用、固定卡不相关、可让位容量不够、任务输入仍在同步时，不会无谓中断最低任务。同为 P0 的等待任务不会抢占先运行的 P0。

最低任务的让位是结束，不是暂停或自动从检查点恢复：先向已核验身份的托管 systemd 单元发 TERM，超过宽限期后才可 KILL；GPU 进程与显存排空、单元/cgroup 安全退出，并经过连续空闲确认后才释放租约、允许冲突的新任务启动。已落盘的工作目录内容和日志保留；程序尚未落盘的内存进度不能保证保留，之后需要用户手动重跑。

旧任务缺省的 `yield_policy=legacy` 不等于显式可中断。旧 `yield_policy=save` 任务虽允许检查点让位，也不符合 Console 的 `preempt_idle_only` 限制，不会因此被中断；**仅设置 `--mode queue` 而漏掉此限制不足以保护旧 save 任务**。外部进程没有托管单元身份/租约，也不属于可抢占对象。共享卡任务不能选 `now`/`save`；旧可信管理员 CLI 的高级 `preempt-now`/`preempt-save` 仍保持原语义，Console 不应把这些模式当成优先级实现。

管理员直接使用 GPUQ 时，等价提交参数为：

```sh
gpu submit -g 1 -p P0 --mode queue --yield now --restart-policy never --preempt-idle-only -- python train.py
gpu submit -g 1 -p P2 --mode queue --yield never --restart-policy never --preempt-idle-only -- python train.py
gpu submit -g 1 -p P4 --mode queue --yield never --restart-policy never --preempt-idle-only -- python train.py
```

状态读取以节点实时 `status`/`show` 为准：`priority` 为数字，`priority_name` 为 `P0`–`P4`，`sequence` 为 FIFO 序号；同时返回 `yield_policy`、`restart_policy`、`preempt_idle_only`、`state`、`state_reason` 和 Unix 秒时间戳。只有实时 `status.daemon.capabilities` 同时包含 `priority-policy-v1` 和 `preempt-idle-only-v1`，门户才应开启此功能，不能凭节点磁盘上有新版程序推断运行中的 daemon 已支持。

原生接口没有预计启动时间或排队位置；界面若按同节点当前 `PENDING` 的 `(-priority, sequence)` 计算位置，应标为快照排位，不是启动时间承诺（固定卡回填、同步阻塞等会影响实际启动）。抢占结束的 job 是 `CANCELED`、attempt 是 `PREEMPTED`，原因包含 `preempted by …; restart disabled`，不能一律显示成“用户取消”。

仅排队中的任务可通过 `gpu --json set-priority JOB idle|normal|high` 修改完整策略。相应 RPC 为 `set_priority`，参数 `job_id`、`priority_class`，可选 `expected` 对象必须同时提供四个旧字段 `priority`、`yield_policy`、`restart_policy`、`dispatch_mode`；CLI 对应 `--expected-priority P2 --expected-yield never --expected-restart-policy never --expected-mode queue`。数据库事务原子核验 PENDING、旧值、无活动 attempt/租约/扩卡/抢占清理，再一起修改四字段，保持 FIFO 序号和 `preempt_idle_only` 不变；拒绝运行中的任务、共享卡转 idle 和自动扩卡任务。不要直接改 SQLite 模拟调档。

daemon 没有代码热重载；停止 daemon 只关闭调度循环/RPC/数据库，不停止独立 systemd job 单元。实际升级前仍须核验现场 unit/cgroup 没有额外绑定，并先备份数据库；不可停止整个用户 manager，也不可在运行中直接覆盖 zipapp 冒险混载新旧模块。

上述行为的无 GPU 回归测试：`python3 tests/gpuq-priority.test.py`。这些测试验证代码契约，不代表任何节点已经升级或完成生产抢占验收。

## 源码包含的高级能力

单机整卡/固定卡、优先级与排队、保守空闲判定、取消与重试、检查点/抢占协议、弹性扩卡协调、共享/HAMi 适配、fleet/cluster、手工同步、团队消息板、可选 Telegram 通知。

这些模块保留是为了兼容与后续开发，不等于门户已对外开放并审计全部功能。检查点/弹性需要训练程序配合；HAMi 需要另装上游运行库；跨机需要管理员单独定义 fleet 与互信。Telegram 需要自己的私有配置，不会自动读取任何现成凭据。先读相应模块与 CLI help，在测试节点验证后再用。

### 高级 fleet / sync 的独立配置

此配置只供可信管理员使用，**不是门户 `inventory.json` 的 `nodes` 清单**，两者不会自动互相生成。每个 `hosts` 条目必须显式给出目标机器上的 `binary` 与 `config` 绝对路径，不再猜测服务用户的主目录。不能用 `~` 代替绝对路径。

例如将自己的 fleet 清单保存为 `~/.config/gpuq/fleet.json`：

```json
{
  "hosts": {
    "gpu-1": {
      "ssh": "gpuops@100.64.10.11",
      "binary": "/home/gpuops/bin/gpu",
      "config": "/srv/gpuq/config.json"
    },
    "gpu-2": {
      "ssh": "gpuops@100.64.10.12",
      "binary": "/home/gpuops/bin/gpu",
      "config": "/srv/gpuq/config.json"
    }
  }
}
```

以上地址、用户和目录都是示例；按各节点实际安装位置填写，并事先确认 SSH 主机指纹与管理员自己的密钥权限。配置正确后，先做只读核验：

```sh
gpu --fleet-config "$HOME/.config/gpuq/fleet.json" --host gpu-1 status
```

`sync` 同样使用这份 fleet 清单并读取显式路径。旧清单已明确填写有效的 `binary` / `config` 时无需改动；旧版本依赖隐式默认值的清单，在升级高级工具前补齐即可。此变化不迁移或重启已部署的 GPUQ，也不影响门户普通用户的 `gpuctl` 工作流。

原始代码中的历史默认目录是 `/data1/gpu-scheduler`；新部署安装器通过显式 `--config` 使用 `inventory.json` 的路径，不要求有名为 `/data1` 的硬盘。训练框架不打包进 GPUQ。

上游依赖、许可与来源见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
