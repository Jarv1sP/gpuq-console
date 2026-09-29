# 作业诊断包

`gpuctl diagnostics JOB --json` / `jobs.diagnostics({jobId})` 返回所属作业的持久诊断包。普通用户仅自己的任务；管理员遵循平台任务查看权限。参数不接受路径、其他身份或机器覆盖。查询不会提交、取消任务或修改调度状态。

主日志末尾直接附加简短诊断摘要：worker 错误片段、OOM / PID 事件、采集缺失提示和诊断命令。诊断库损坏或未安装不会遮蔽原主日志。网页每个任务的「日志」窗口内可选择「诊断包 / 历史分配」，查看有限 worker 日志、资源计数及历史 GPU UUID/index/start/end，并下载 JSON；下载前请检查脱敏内容。窗口关闭、退出登录、切换账号或角色时会清除内容，旧请求的迟到响应不会显示到新身份。

包包括最近一次运行的 Ray worker 有限日志尾部、runner 退出码（若成功保存）、可验证的 systemd 退出信息、内存/进程数峰值、OOM 与 PID 拒绝计数；另外保留最多 16 次 GPUQ attempt 的 GPU UUID/index、创建、启动、结束时间与退出原因。attempt 时间是调度记录，不冒充精确设备分配/释放时间。没有采集到的数值是未知，不是零；采样 `*.current` 仅为观测高水位，内核 `*.peak` 才是内核峰值。

平台状态和日志证据分别呈现：`schedulerState=RUNNING` 表示调度器仍确认主进程运行，不保证所有 Ray worker 健康。`workerErrorEvidence=true` 提示日志含明确错误特征，但不能单独把任务判成 FAILED。`state=PARTIAL` 表示采集不完整或心跳失效，`UNAVAILABLE` 表示没有持久诊断；旧任务的已销毁 `/tmp` 无法追溯恢复。

## 范围与隔离

每个 portal 作业与 systemd InvocationID 独立绑定，宿主目录为私有 `diagnostics/JOB/INVOCATION/`。仅 `runtime` 映射到 sandbox `/run/gpuq/runtime`；身份记录、退出回执和报告不映射给训练进程。Ray 使用 `/run/gpuq/runtime/ray` 时收集白名单 session 日志；不会跟随 `session_latest`、目录/文件符号链接、硬链接或特殊文件，不扫描系统 `/tmp`、journal、其他用户文件、进程环境或命令参数。

显式设置 `RAY_TMPDIR=/tmp/...`、`ray.init(_temp_dir=...)` 等可能把日志移出受管理目录；这部分不会被捕获，报告始终注明该限制。若原作业只有主日志中的 Ray 启动信息，不能据此宣称 worker 没有错误。

每个文件保留至多 64 KiB，最多 32 个文件，日志文本预算 700 KiB，整个返回 JSON 包至多 1 MiB（包含 JSON 转义后的大小）。白名单文件过多时截断，近期 stderr 优先。常见 token、密码、Bearer、URL 凭据和私钥做尽力脱敏，但日志是用户内容，分享前仍须检查。GPU 主日志继续通过 `logs` 获取，不重复纳入诊断包。

## 资源与保留

独立 observer 不在训练 cgroup 内，最多每节点 16 个采集器；每个限制为 CPU 10%、内存 128 MiB、16 tasks、低 IO 权重和最长 30 天运行。每 2 秒直接读固定 cgroup 文件，每 10 秒收集日志；不会每 2 秒启动 systemctl。初始绑定和结束时才查询 systemd。runner 的可选收尾钩子保存最后计数；硬杀或节点重启可能缺失最终计数，报告明确部分可用。采集失败不改变训练退出码。

已结束诊断默认保留 30 天，管理员可在节点 `node-config.json` 设置 `diagnosticsRetentionDays`（1–365）。安装器启用用户级 `gpuq-diagnostics-gc.timer`，每小时清理；手工发布也必须同步安装并启用此 timer/service。GC 独立限制为 CPU 10%、128 MiB、16 tasks、最多运行 300 秒、单实例锁；通过持久游标轮转，每批至多处理 64 个任务 / 每任务 16 次运行，目录枚举使用有界内存。因此保留期是最短保留策略，不承诺到时精确清除。

原 cgroup 确认已空、消失或已被另一实例替换后，GC 才会把失联采集器遗留的 STARTING/CAPTURING 持久化为 PARTIAL，抽取最后一份有限日志，然后删除该次运行的原始 runtime（包括误写入其中的 spill），只留下有限诊断包。活跃采集器持锁、活跃 cgroup、计数无法读取或身份不匹配时不删除；清理中断可重试。原始临时目录不会按 30 天继续保留。

报表大小限制不是活跃 Ray runtime 的磁盘配额。适配器将对象 spill 默认指向沙箱临时 `/tmp`，但用户显式覆盖仍可能写入持久 runtime；任务结束并确认后会被清理。未配置磁盘配额时不能宣称活跃原始日志 / 临时对象总量有硬上限。
