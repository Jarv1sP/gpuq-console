# 独立排队等级与主动让位

网页展开“提交训练 → 自定义 GPUQ 调度”并勾选启用。等级、让位和恢复分别设置，
低等级不再自动表示同意丢弃状态。节点须先部署训练控制通道（PR #4）与本 PR，
否则网页阻止提交，API/节点也会拒绝；不会降级成旧预设。

```sh
# P1 排队，但不允许自动中断
gpuctl run --rank P1 --yield never -g 1 -- python train.py

# 明确允许高优先级任务立即中断；不保存、不自动从头重跑
gpuctl run --rank P1 --yield now -g 1 -- python disposable.py

# 本轮保存后让位，之后排队并从 checkpoint 恢复
gpuctl run --rank P1 --yield save --checkpointable --restart-policy on-preempt \
  -g 2 -- python -m torch.distributed.run --standalone --nproc-per-node=2 train.py
```

- P0–P4 越大越优先；沿用现有权限，成员可选 P0–P2，P3/P4 由管理员提交。
- 自动抢占只针对严格低等级、明确 `yield=now/save` 的任务，不中断 `never` 或历史
  `legacy` 任务，也不碰外部进程。被抢占多卡任务作为一个整体让位，不只杀其中一张卡。
- `--yield save` 必须接入 `gpuq.checkpoint.checkpoint_at_epoch_end` 并读取
  `resume_checkpoint_path()`；DDP 所有 rank 协同，保存 model/optimizer/scheduler/RNG
  及进度。`--checkpointable` 是你的明确确认，不是自动改写训练代码。
- 保存失败/超时不升级为强杀。只有协议确认后才让位；恢复文件缺失则拒绝新 attempt。
- `--restart-policy never` 为默认，让位后结束；`on-preempt` 只接受保存让位。
  手动取消或训练失败不自动重试；排队、让位中、状态未知仍计入额度。
- 新选项与旧 `--priority idle|normal|high` 互斥。旧预设及已存在任务完全不改写。
- 默认 `queue` 按低等级任务自己的 now/save 约定让位；请求方另可主动选模式1/2。
- `--mode preempt1` 请求保存后让位，只选明确同意且接入checkpoint的低等级任务；
  `--mode preempt2` 对now任务立即让位，对save任务仍先保存，不越过对方保存约定。
  never/legacy、共享任务、外部进程和同等级任务均不加入新模式抢占范围。
  缺新鲜 `preempt-opt-in-only-v1` 能力会在预留/派发前拒绝；queue旧用法不需新能力。
- 本批不改配额、弹性卡数或自动选服务器；原生旧请求的既有范围和幂等摘要保持兼容。
- 断线重试复用输出的 `--key UUID`；不能用同一 key 换 rank/让位/恢复策略。

```sh
gpuctl run --rank P2 --mode preempt1 -g 1 -- python urgent.py
gpuctl run --rank P2 --mode preempt2 -g 1 -- python urgent.py
```

## 共享长训练的边界

普通共享和 HAMi 共享均只支持 `mode=queue`、`yieldPolicy=never`、`restartPolicy=never`，不支持弹性扩卡。`checkpointable=true` 本身可保留，表示程序具备保存能力，不会使共享任务自动获得平台让位或恢复能力。

```sh
# 共享长训练：程序自行周期保存；中断后手动重新提交并指定恢复文件
gpuctl run --gpu 0 --share --vram-mib 8192 --rank P2 \
  --yield never --restart-policy never --checkpointable -- python train.py
```

平台自动保存让位及从 checkpoint 恢复，仅在不带 `--share` 的任务上使用。共享任务可能与外部程序共卡，因此不会擅自停止整卡或把同卡其他进程纳入让位。共享模式下 `--yield save`、`--restart-policy on-preempt` 的拒绝是当前明确的功能边界，而不是已提交的训练失败。

API `jobs.submit` 可传 `scheduling: {rank, yieldPolicy, restartPolicy, checkpointable, mode?}`，
不与旧 `priority` 同时传入。该对象作为任务不可变提交内容保存；本 PR 不提供运行中修改它的接口。
mode支持queue/preempt1/preempt2及canonical preempt-save/preempt-now；显式queue归一为旧默认格式。

新模式需核心schema11→12迁移及节点/门户匹配版本：维护者先备份状态，安排核心维护窗口，
确认native能力，再开放门户/CLI；本PR不部署、不停止生产任务。迁移不改变旧任务/attempt/lease
或替旧任务添加同意。回退前须停止新增新模式并等其终态；不能用旧程序直接打开新schema。
