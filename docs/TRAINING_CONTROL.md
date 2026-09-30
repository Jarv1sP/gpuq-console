# 训练控制通道

节点安装器为两个 sandbox profile 接通原 GPUQ 的逐 attempt 控制目录与只读 SDK。
没有开启新的默认抢占，也不重启现有训练；提交端开放保存让位、弹性参数是后续独立改动。

训练内可直接 `from gpuq.checkpoint import checkpoint_at_epoch_end, resume_checkpoint_path`，
进度使用 `from gpuq.progress import ProgressReporter`。SDK 来自实际运行调度器的 pyz，
不用在每个项目中另装可能协议不匹配的版本。

- 仅映射当前 attempt 到 `/run/gpuq/control`，不暴露父目录、数据库或调度 socket。
- 开启通道后 `GPUQ_JOB_ID` 是原生 J-ID；平台 UUID 用 `GPUQ_CONSOLE_JOB_ID`，
  旧的 `AMAX_JOB_ID` 仍是平台 UUID。未配置通道的旧安装行为不变。
- 保存路径用 `/outputs/checkpoint.pt`（项目任务）或 `/workspace/checkpoint.pt`（旧工作区）。
  ACK 保存绝对沙箱路径；下次 attempt 使用同一持久目录。恢复文件缺失、越界或非法时
  拒绝启动，绝不悄悄从头训练。不依赖宿主机存在 `/outputs` 这个全局目录。
- 保存/加载 model、optimizer、scheduler、随机数和训练计数由训练代码负责。DDP 必须
  所有 rank 在同一 epoch 边界调用适配器并使用 `broadcast_decision`；只映射目录不能
  把任意训练自动变成可恢复训练。保留适配器的退出码 75，不要把它改成成功退出。
- 实际 world size、合法卡数及 batch 参数只从调度器白名单传入；不透传宿主环境/密钥。
- 终端不会得到训练控制目录。更新只作用于以后启动的 attempt。

发布时由维护者手动更新 helper、选定 profile 的 runner 和 node-config 中的
`controlRoot`/`gpuqArchive`（对应实际 GPUQ 配置）。旧配置没有 `controlRoot` 时保持旧行为；
一旦配置，缺失/不匹配的 attempt、SDK、恢复文件都会阻止该次训练启动。
回退 runner/config 不会删 checkpoint；需要恢复/保存让位的任务不应在回退后继续提交。
