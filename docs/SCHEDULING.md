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
- 仍使用原 GPUQ 的 `queue` 模式，按被抢占任务的明确同意自动选立即/保存让位。
  本批没有开放可扩大历史任务抢占范围的强制请求模式，也没有修改配额或自动选服务器。
- 断线重试复用输出的 `--key UUID`；不能用同一 key 换 rank/让位/恢复策略。

API `jobs.submit` 可传 `scheduling: {rank, yieldPolicy, restartPolicy, checkpointable}`，
不与旧 `priority` 同时传入。该对象作为任务不可变提交内容保存；本 PR 不提供运行中修改它的接口。
