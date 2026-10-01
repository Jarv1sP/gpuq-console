# GPUQ Console 用户手册

> 初次使用请阅读新版 [使用指南](docs/USER_GUIDE.md)：包含原生 Windows PowerShell 安装，以及开发、训练、数据集和排队流程。本页保留旧版详细说明供兼容查阅；网站只展示新版指南。

入口：https://gpu.example.com 。网页、自己电脑的命令行共用账号与任务，不需要 ChatGPT 账号。你的电脑只需能通过 HTTPS 访问网站，**不需要安装或加入 Tailscale（Tail）**。

## 第一次使用

管理员发给你注册码后，在网站注册自己的用户名、密码。注册成功自动进入“算力总览”，可用额度为 0；不用再找管理员手动创建账号。管理员会自动看到待处理账号，批准后你的资源页自动更新。

这里注册的是**平台账号，不是给电脑登记设备**。注册、安装客户端或登录都不会把你的电脑自动加入 Tail，也不会给你创建服务器系统登录账号。换一台电脑仍用同一个平台账号登录。

## 页面怎么用

| 左侧入口 | 用途 |
|---|---|
| 我的工作台 | 在手选机器中管理项目、开发终端、代码与环境版本、训练任务和结果 |
| 算力总览 | 查看获授权机器的逐卡利用率、显存、温度、功耗与 CUDA 计算进程占用；普通用户不显示他人的程序和系统用户名 |
| 数据集 | 在获授权机器准备固定版本的本地副本，就绪后选择用于训练 |
| 协作区 | 阅读公告、发布问题反馈、回复帖子和协调使用安排；见[协作手册](https://gpu.example.com/guide/community) |
| 成员授权 | 仅管理员可见，管理账号、注册码、机器授权和卡数额度 |

界面只提供一个“使用指南”入口；管理员手册保留在仓库，不由网站提供。管理员分配额度后，实际操作都在“我的工作台”，不用到用户管理页开终端或提交任务。

新终端各自独立，重连、分离和接管见[终端会话手册](https://gpu.example.com/guide/terminal-sessions)。任务的 worker 日志与历史 GPU 分配见[诊断手册](https://gpu.example.com/guide/diagnostics)。[Ray 资源手册](https://gpu.example.com/guide/ray-resources)仅适用于管理员明确启用并验证的节点；默认公共 P0 档不启用这项资源改造，未采集到的旧任务信息仍显示未知。

## 安装命令行客户端

电脑需要 Node.js 22.13+。只安装一次客户端：

```sh
curl -fsSL https://gpu.example.com/install.sh | sh
```

重新打开终端，然后：

```sh
gpuctl login
gpuctl use gpu-1
gpuctl project create my-project
gpuctl ssh
```

`login` 会提示用户名和密码；密码不回显。`use` 记住服务器，不必每次再写；机器名称以网站和 `gpuctl state` 的实际清单为准，只允许你获批的机器。`project create` 创建并选中该机上的项目；已有项目用 `gpuctl project use my-project`。项目名为 1–48 位小写英文字母、数字、`_` 或 `-`，以字母开头。`ssh` 打开交互式命令行，不需要另配 SSH 密钥或服务器密码。用户名支持 2–24 个小写英文字母、汉字、数字、下划线和连字符，以字母或汉字开头。

上面的安装命令适用于 macOS/Linux；Windows 请使用新版 [使用指南](docs/USER_GUIDE.md) 中的原生 PowerShell 安装器，不需要 WSL。这里的 `gpuctl ssh` 是通过 HTTPS 连接个人终端的快捷命令，不是原生 SSH 协议端口；暂不能作为 VS Code Remote-SSH、SFTP 或 rsync 的目标。它同样不要求你的电脑加入 Tail。

旧用户直接用 Tail + OpenSSH 登录服务器是另一套入口，继续使用需要原有网络与系统账号权限。普通平台注册不会自动获得这些权限，也不需要它们来运行平台训练任务。

旧版本已安装的 `amax` 命令仍可使用；新安装统一使用 `gpuctl`。新版兼容旧登录缓存和环境变量，不需要因项目改名重新注册账号，详见[名称更新与兼容](docs/MIGRATION.md)。

## 项目代码与环境

每个账号、每台机器、每个项目分别隔离。项目开发终端中：代码在 `/workspace`，个人环境在 `/opt/project-env`，个人目录在 `/home/gpuq`。基础 Python/Conda 只读保留在 `/opt/conda`，首次打开项目终端会准备项目自己的 venv，安装依赖不会覆盖全局 Conda 或其他项目。

```sh
gpuctl push .
gpuctl ssh
# 以下两条在打开的服务器终端内执行
python -m pip install -r requirements.txt
exit
```

`push .` 上传当前目录内容到选中项目的开发代码区，同名文件更新。项目模式会跳过 `.git`、`.venv`、`venv`、`node_modules`、`__pycache__`、`.ssh`、`.aws`、`.azure`、`id_rsa`、`id_ed25519`、`.env` 和 `.env.*`（保留 `.env.example`），并打印提示；不会递归跟随软链接。其他名字的敏感文件不会自动识别，上传前仍需检查。不要把 Mac 的 Python 环境打包覆盖 Linux 环境，也不要把 TB 数据集当代码上传。

工作区长期保留，退出终端不会删除文件。终端中的 `/outputs` 是项目开发用临时结果区，不是某次训练的结果。训练只使用发布后的固定代码和环境版本；草稿继续修改不会改变已经发布的版本。

终端本身不占 GPU，不挂载 GPU。验证 CUDA 或跑训练请用 `gpuctl run`，不能绕过队列直接在普通终端拿卡。终端上限 2 核 CPU 额度、8 GiB 内存，无输入 1 小时或累计 6 小时自动结束。`exit` 结束会话；`Ctrl+]` 仅断开，再次 `gpuctl ssh` 可接回。

## 发布并训练

在自己电脑的项目目录：

```sh
gpuctl project publish
gpuctl project status
# 对应版本显示 READY 后提交
gpuctl run -g 1 -- python train.py --output /outputs
gpuctl jobs
gpuctl logs 任务ID
gpuctl watch 任务ID
gpuctl files --job 任务ID
gpuctl pull --job 任务ID model.pt ./model.pt
```

`--output` 是示例训练脚本自己的参数，请换成你的程序实际支持的输出参数。程序须把日志文件、checkpoint 等可写产物放到 `/outputs`，不能写只读代码区 `/workspace`。每次训练有独立的 `/outputs` 和临时 HOME，不与另一任务混用。标准输出仍通过 `gpuctl logs` 查看。

`project publish` 在后台冻结当前代码和项目 venv，状态未 `READY` 时不能提交这个版本。`run` 默认使用最新 READY 版本，不会偷偷发布草稿；如需固定旧版本，加 `--release 完整64位版本号`。若新版本发布失败，但旧版本仍 READY，默认运行的是旧版本；提交前核对输出的版本号。任务在你手选的服务器中自动分配所需数量的 GPU，不会换服务器；关电脑不影响训练。日志为最近 200 行。

```sh
gpuctl cancel 任务ID
```

取消后等待 GPUQ 确认停止，再释放额度；后台子进程一起清理。任务 ID 是平台返回的 UUID，不是旧 GPUQ 的 `J...` 编号。

`gpuctl watch 任务ID` 在当前 SSH/本地终端持续显示轮次、步数、训练自报 ETA，以及异常和最终状态。默认每 5 秒核对；`--interval 10` 调整间隔，`--json` 输出每次变化的 JSON 行。Ctrl+C 只停止查看。断网或节点状态 UNKNOWN 时提示重新连接，不重试提交。完成退出码为 0，失败为 1，取消为 130，状态未知为 3。网页任务表同步显示相同进度；未经适配的训练显示“进度未上报”，仍能查看调度状态与日志。

轮次、指标与 ETA 来自训练自己上报，不从日志猜测。沙箱内上报需要已部署 PR #4 的训练控制/SDK 通道；本功能只读现有进度，不自行挂载该通道。未部署或未适配时显示“进度未上报”，调度状态与日志仍可查看。主进程（DDP rank 0）适配示例：

```python
from gpuq.progress import ProgressReporter
reporter = ProgressReporter()
# 每轮完成后：epochs_completed 是已完成轮数，不能用当前轮次推断终态
reporter.update(phase="train", epochs_completed=epoch + 1,
                epochs_total=epochs, metrics={"loss": float(loss)})
```

只上报数值指标和简短说明，不放令牌、个人数据或完整日志。训练上报达到 100% 并不等于调度器已经确认完成；`severity="error"` 只反馈异常，不会自动重启或释放 GPU。保存恢复继续使用原来的 checkpoint 接口，两者独立。

管理员配置你的 Telegram 收件人后，可执行 `gpuctl notify 任务ID on` 开启该任务的完成、失败、训练警告/异常和进度停滞通知；网页任务表也有开关。`gpuctl notify 任务ID status` 查看待发/失败数量，`gpuctl notify 任务ID off` 关闭。关闭 SSH 不影响通知。默认不发送；节点失联本身不会通知“训练失败”。通知只影响消息，不会重启、抢占或取消训练。

## 上传自己的数据或使用已授权数据集

普通成员可把本机目录上传为个人数据集；先选择已授权服务器，再执行：

```sh
gpuctl use gpu-1
gpuctl data upload ./my-data --name my-data
```

名称使用 1–40 位字母、数字、下划线或连字符。上传按文件校验并可断点续传，网络中断后重复同一命令；上传期间不要改目录。成功后复制返回的**完整数据集 ID@版本**与训练路径，个人 ID 不等于输入的短名称。数据只在所选机器可用，上传不占 GPU，也不会自动跨机器同步。

网页左侧“数据集”提供相同的目录上传和进度。关闭页面停止传输，但服务器已开始的校验继续；重新选择同一目录可继续。查看上传状态用 `gpuctl data upload-status UPLOAD_ID`；放弃自己的未完成上传用 `gpuctl data upload-discard UPLOAD_ID`，不会删除已 READY 的数据。HTTPS 上传经门户中转，大量小文件或 TB 级数据不应视为高速内网传输。

数据准备与项目发布分开进行，准备期间不占 GPU。选择训练机器和项目后，从数据集目录复制完整的 `名称@64位版本`：

```sh
gpuctl use gpu-1
gpuctl project use my-project
gpuctl data list
gpuctl data prepare NAME@VERSION
gpuctl data status NAME@VERSION
```

将示例 `NAME@VERSION` 替换为目录中的真实固定版本。显示 `READY` 后再运行：

```sh
gpuctl run -g 1 --data NAME@VERSION -- python train.py --data /data2/NAME --output /outputs
```

平台的 `--data` 位于 `--` 前，训练程序参数位于后面。作业内 `/data2/NAME` 是只读本地副本，输出写入 `/outputs`。普通开发终端不自动挂载数据集。旧大数据目录不会自动搬走或删除，但登记名称不等于该机器已经准备完成。

网页左侧“数据集”也可选择服务器、准备版本；显示“本机已就绪”后点“用于训练”，核对工作台机器与版本，再填写命令提交。准备过程在后台继续，状态需刷新；失败或长时间不变化时用 `data status` 查看结果，不能把“准备中”当作可训练。

项目归属你明确选择的服务器；切换机器不会复制项目、环境或结果，也不会自动切到同名项目。新机器先创建/选择项目，再上传、安装依赖、发布；数据可独立准备本地副本。项目流程见 [项目手册](docs/PROJECTS.md)或本站[在线项目手册](https://gpu.example.com/guide/projects)；数据状态见 [数据集手册](docs/DATASETS.md)，或本站[在线数据集手册](https://gpu.example.com/guide/datasets)。

## 多卡与显存

```sh
gpuctl use gpu-2
gpuctl project use my-project
gpuctl run -g 4 --min-vram 24 --name ddp -- python -m torch.distributed.run --standalone --nproc-per-node=4 train.py --output /outputs
```

`-g 4` 申请同一服务器的 4 张整卡。`--min-vram 24` 筛选每张卡物理显存至少约 24 GiB 的机型，不是显存切片；驱动预留的少量容量不影响 24/32 GiB 型号匹配。训练代码必须支持多卡，不会自动改写程序。

需要接入训练进度或保存/恢复适配器时，见[训练控制通道](docs/TRAINING_CONTROL.md)。
通道接通不等于任意脚本自动支持保存让位；当前默认提交策略不变。

新提交不接受 `run auto`：你选择服务器，调度器在该机内分配卡，不要求你手选 GPU 编号。当前不自动将跨机显存合并或启动跨机 DDP。

## 任务优先级与排队

需要独立选择 P0–P4、“立即/保存后让位”和 checkpoint 恢复时，使用网页“自定义 GPUQ 调度”
或 CLI `--rank/--yield/--restart-policy`，见[简明用法](docs/SCHEDULING.md)。以下旧预设保持兼容。

支持新版优先级策略的节点提供以下选择。网页“提交训练”可选择，CLI 在 `--` 前加 `--priority`：

| 档位 | 谁可选择 | 含义 |
|---|---|---|
| `normal`（普通，默认） | 所有已授权用户 | 普通排队；不会因后来提交的任务自动中断 |
| `idle`（最低、可中断） | 所有已授权用户 | 让空闲资源跑可丢弃的工作；普通或高优先级任务需要资源时，允许结束它来让位 |
| `high`（高） | 管理员 | 优先排队，可让最低任务让位；不会自动中断普通任务 |

```sh
gpuctl run -g 1 --priority normal -- python train.py --output /outputs
gpuctl run -g 1 --priority idle -- python disposable_trial.py --output /outputs
gpuctl jobs
```

**最低优先级不是“慢一点运行”**：它明确允许中断整个训练进程。让位后默认结束，保留已经写入的输出和日志；不自动重新排队、不替程序保存内存状态，也不保证有可恢复的 checkpoint。仅将可丢弃、可自行恢复的训练设为最低。平台优先级是 GPUQ 排队/让位策略，不是 Linux `nice`，也不保证某个时间点开始运行。

任务列表显示平台档位、节点原始优先级、调度状态、节点返回的原因和最近核对时间。只有节点确证的抢占才显示“让位结束”；普通取消仍是“已取消”。调度结果是最近一次核对快照，不是实时承诺；资源采样与任务核对有各自时间。旧任务没有确认的档位显示“未标注”，不能按普通或最低推断。

尚未确认支持新版安全策略的节点不能选择最低/高档位或调整队列；默认提交保留旧流程，旧任务和外部 GPU 进程不会自动纳入新策略。管理员只能调整已确认、尚未启动的新版平台队列任务；普通用户不能自升到高优先级。调整请求仍需节点核验，若任务已经启动，需刷新后以实际状态为准。

### 只调整排队顺序

管理员可对尚未启动的任务执行 `gpuctl priority 任务ID P0` 至 `P4`；
`idle`、`normal`、`high` 兼容别名分别表示 P0、P2、P4。这次操作只改队列优先级，
不改变原来的让位、checkpoint、重启策略，也不重置 FIFO 序号。
例如原来“保存后让位、被抢占后重排”的任务，调为 P3 后仍保持这两项约定。
任务列表分别显示实际 P 值和让位/恢复方式；不要仅根据 P0 推断任务可中断。
新任务提交时的三种预设继续兼容；独立的提交策略选项已由 `--rank/--yield/--restart-policy` 提供，仍需节点确认对应能力，见[调度用法](docs/SCHEDULING.md)。

节点必须确认 `priority-rank-v1`；旧节点不支持时拒绝修改，不回退到修改整套策略。

## 机器与配额

| 名称 | GPU | 每卡显存 |
|---|---|---|
| gpu-1 | 8 × RTX 5090 | 32 GiB |
| gpu-2 | 8 × RTX 4090 | 24 GiB |
| gpu-3 | 6 × RTX 4090 | 24 GiB |
| gpu-4 | 8 × RTX 3090 | 24 GiB |

上表仅为示例部署，实际名称、型号和容量由管理员配置。

“算力总览”仅对获授权机器显示逐卡监控；未授权机器只显示容量与待授权提示。节点约每分钟采样，页面每 15 秒读取最近快照，并不代表每 15 秒重新检测显卡。

进程列表仅包含 CUDA 计算进程，不包含图形进程；没有计算进程也不等于卡可立即调度。普通账号仅查看 PID 与占用显存，程序名和系统用户名只对管理员显示，不暴露他人的命令或项目路径。管理员还能展开原 GPUQ 队列；自己的训练状态和额度以“我的工作台”为准。

显存占用和 GPU 利用率不是一回事，进程存在也不一定正在持续计算。指标缺失、进程列表不完整、无法采集或数据过期都会标记未知，不能把空白、`—` 或采集失败当作零占用/空闲卡。

管理员设置每机用卡上限与跨机同时用卡总数。排队、启动、运行和状态待核对都计入额度，成功/失败/取消确认后释放。授权不是物理卡预留；没有空闲卡会排队。兼容的 `normal/idle/high` 预设只会让明确选择最低、可中断的受管任务让位；显式抢占请求另按等级与让位约定处理，见[使用指南](docs/USER_GUIDE.md)。这些入口不会接管旧任务或任意外部进程。

项目终端只看见该项目开发区；训练只读挂载发布代码、环境及显式选择、获授权且已就绪的数据集，并仅挂载获配 GPU。清空 `CUDA_VISIBLE_DEVICES` 也不能多拿其他卡。每台机器工作区独立，不自动同步；固定代码/数据版本的手动复制见[同步手册](docs/SYNC.md)，目标环境仍须单独准备和发布。训练系统内存默认每 GPU 32 GiB、CPU 每 GPU 4 核额度；不是 GPU 显存限制。

## 老工作区兼容

从未选择项目的已有账号仍用原个人 `/workspace`，原上传和任务不搬走、不删除。选中项目后，`push/files/ssh/run/pull` 自动针对该机项目；临时回旧空间加 `--legacy`，例如 `gpuctl ssh --legacy`、`gpuctl run --legacy -g 1 -- python train.py`。旧模式输出仍在原工作区，没有 `--job` 结果目录；`--legacy` 不能和 `--project`/`--release` 混用，也不允许 `run auto`。新项目不会自动导入旧代码或环境。

## 网页也能做什么

登录后可打开终端、上传文件、提交训练、看日志、取消任务、下载结果。网页里的“断开”保留终端，“结束终端”才关闭；发布项目前需要真正结束开发终端，CLI 用 `exit` 而非 `Ctrl+]`。浏览器下载超过 100 MiB 请用 CLI；文件经 VPS 转发，不是高速直连传输。项目代码单文件上限 4 GiB，旧工作区 API 上限 100 GiB；磁盘剩余不足 10 GiB 拒绝新上传。

## 弹性卡数与自动扩卡

`-g` 是最大卡数，`--min-cards` 是最少启动卡数。声明 global/micro batch 后，
GPUQ 只选 `globalBatch / (实际卡数 × microBatch)` 为整数的卡数，并按当前最多可用合法卡数启动：

```bash
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 -- python train.py
```

此例合法卡数为 1、2、4、8；有 3 张空卡时先用 2 张，累积 16 次，global batch 仍为 256。
任务始终预留最大卡数的个人额度，实际分配显示在任务列表中。

空卡后来释放时，下面的选择会在 epoch 保存后重新启动 DDP，恢复模型、优化器和进度，并使用更大合法卡数：

```bash
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 --auto-expand \
  --rank P1 --yield save --checkpointable --restart-policy on-preempt -- python train.py
```

训练必须按 `GPUQ_ASSIGNED_GPU_COUNT` 启动 ranks，使用 `gpuq.elastic.plan_elastic_batch()`
的 `gradient_accumulation_steps`，并接入前述 checkpoint/恢复适配器。global batch 固定时 LR 不随卡数改变。
保存超时不会强制杀训练；实际扩卡可能晚于空卡释放。调度器不会自动改写现有训练代码。
网页“弹性卡数”提供相同选择；需要节点与调度器一起升级并确认能力后才可提交。

## 固定显卡与主动共享

先查看网页资源页中的逐卡显存和进程，选择服务器上的物理 GPU 编号：

```bash
gpuctl run --gpu 0,2 -- python train.py        # 固定两张卡
gpuctl run --gpu 3 --share --vram-mib 4096 -- python small.py
```

共享只需新任务提交者主动同意，可以挤到外部任务或已经运行的普通任务所在的卡上；
占用过高时按声明的显存预算排队。共享任务仍占 1 张个人额度，不能弹性扩卡或自动让位。
固定选卡只等指定卡，不会改选别的卡。网页“固定 / 共享选卡”提供相同功能。
节点登记任务时绑定物理显卡 UUID；驱动重排编号后仍按同一物理设备分配。

普通共享的显存预算用于准入，不是硬限制。节点安装并验证 HAMi 后，可选择限制自己任务的 CUDA 显存：

```bash
gpuctl run --gpu 3 --share --vram-mib 4096 --hami --sm-percent 50 -- python small.py
```

SM 限制只在本机验证过 SM 功能后接受，不保证性能比例；同卡外部进程不受你的限制。
HAMi 请求不会降级为普通共享；运行库或节点能力不可用时拒绝提交。选卡不支持与弹性范围混用。

## 网页任务留言

后台启用任务留言后，打开“协作区 → 任务留言”。先选择“随任务结束删除”并选择自己的任务，或选择“非任务留言，手动删除”。支持刷新、编辑与删除；发送结果不确定时重试原内容。旧后台未启用时不显示此入口，公告、反馈和聊天照常使用。
## 命令行任务留言

`gpuctl notes` 查看共享留言；`gpuctl note --job 任务UUID "留言"` 关联自己的任务，
确认完成/失败/取消后自动清理正文。排队、被抢占、失联/待核对期间保留。
`gpuctl note --general "通知"` 是不随任务清理的长期留言；`gpuctl note-delete 编号`
手动删除。所有登录成员可见，不要填写敏感信息。完整规则见[协作手册](docs/COMMUNITY.md)。

## 常见情况

- 超出额度：减少卡数、等待自己的任务结束，或请管理员增加额度。
- `UNKNOWN`：节点状态暂不确定，后台每 15 秒核对，保留额度，不等于任务停止。
- 优先级调整待核对：刷新任务状态；不要把网页请求已发送当成节点已经完成修改。无法确认时继续保留额度。
- “让位结束”：最低任务已被确认中断；先检查已保存输出，再决定是否手动重新提交。
- 机器状态过期：暂拒绝新提交，已有训练不受影响；联系管理员。
- 提交超时：用输出的 `Submission key` 加 `--key UUID` 和相同参数重试，避免重复任务。
- `FAILED`：先 `gpuctl logs 任务ID`。原宿主机共享路径没挂载，不表示文件被删除。
- 下载拒绝覆盖本地已有文件；换目标文件名。
- 会话过期：重新 `gpuctl login`。`gpuctl logout` 主动退出。

默认输出为可读的任务列表、状态和原始日志；任务列表显示最近 50 条。进阶脚本可加 `--json` 获取完整结构化输出；密码支持 `--password-stdin`。平时不需要这些参数。原服务器 `gpu` 工具保留给旧用户，平台统一使用 `gpuctl`，正式训练不用演示接口 `request/release`。
