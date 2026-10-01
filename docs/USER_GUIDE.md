# 使用指南

网页和 `gpuctl` 共用账号、项目与任务。下面只说明日常用法；入口是否可用，以当前门户和节点能力为准。

## 首次使用 {#start}

### 注册、安装与选机器

打开平台，用管理员提供的注册码注册。新账号的用卡额度为 0；管理员授权服务器和卡数后才能训练。用户电脑不需要安装 Tailscale，也不需要服务器 SSH 密钥。

自己的电脑需要 Node.js 22.13 或更高版本。Windows 可直接使用 PowerShell，不需要 WSL；从平台下载安装客户端：

```powershell
node --version
$installer = Invoke-WebRequest 'https://gpu.example.com/install.ps1' -UseBasicParsing -MaximumRedirection 0
& ([scriptblock]::Create($installer.Content))
```

macOS、Linux 或已有 WSL：

```sh
node --version
curl -fsSL https://gpu.example.com/install.sh | sh
```

将 `https://gpu.example.com` 换成自己的平台地址。安装只写用户目录；不需要管理员权限，不修改 PowerShell 执行策略。安装或更新后重新打开终端；客户端更新使用同一安装命令。

```sh
gpuctl login
gpuctl state
gpuctl use MACHINE_ID
```

按提示输入用户名和密码。`MACHINE_ID` 从平台复制真实的机器 ID，后面的 `JOB_ID`、`SESSION_ID` 和版本号也都要换成实际值。`use` 记住当前服务器；切换服务器不会自动搬运代码、环境、数据或结果。

### 网页入口

- 我的工作台：选机器、创建项目、开发终端、发布和提交训练。
- 算力总览：逐卡占用和采集时间；未知或过期不代表空闲。
- 数据集：个人上传、数据终端、固定版本与准备进度。
- 协作区：公告、交流和任务留言。
- 维护申请：需要系统权限的特殊操作；普通开发和训练无需审批。

### 姓名与描述（需任务信息新版）

只有门户和客户端支持任务信息新版时，才有「设置姓名」「任务描述」和全队列查询。没有这些入口可先用 `gpuctl state`、`gpuctl jobs`，请管理员升级；不要把指南更新当作功能已经上线。

```sh
gpuctl profile --display-name "张三"
```

注册时也可填写姓名。未设置时显示用户名，登录账号和权限不变。新任务保存提交时姓名，旧任务没有姓名快照时使用现有姓名；描述由自己填写，同机器授权成员可见，不要填写密码或令牌。

## 项目开发 {#development}

### 上传代码和安装依赖

在自己电脑的代码目录执行：

```sh
gpuctl project create my-project
gpuctl push .
gpuctl ssh
```

进入项目终端后执行：

```sh
python -m pip install -r requirements.txt
python -m pip check
exit
```

代码在 `/workspace`，私人环境在 `/opt/project-env`。默认继承基础 Python 包；需要空环境时新建 `gpuctl project create clean-project --env-mode isolated`。项目名以小写字母开头，可含数字、下划线和连字符，最长 48 字符。

继续已有项目用 `gpuctl project use my-project`；查看项目用 `gpuctl project list`。`push .` 跳过常见环境和秘密文件，但不能识别所有敏感内容，上传前自己检查；不会删除服务器多出来的旧文件，也不会上传数据集或替你迁移本机环境。

### 终端断开与重连

每次 `gpuctl ssh` 都会**新建独立终端**。它走 HTTPS，不是原生 SSH，不能直接填入 VS Code Remote-SSH、SFTP 或 rsync。

- `exit` 或网页「结束终端」：结束会话；`exit` 结束的终端不能重连。
- `Ctrl+]` 或网页「断开」：只断开连接，会话继续运行。
- 重连原会话：使用原服务器、项目及会话 ID；另一客户端仍在操作时，明确协调后才用 `--takeover`。

```sh
gpuctl ssh --reconnect SESSION_ID
```

开发终端**没有 GPU**，限 2 核 CPU 额度、8 GiB 内存；连续无输入 1 小时或累计 6 小时结束。CUDA 检查也应提交训练任务。项目内可以安装 Python 包，不能修改基础 Conda 或安装系统包；系统维修走[维护申请](/guide/troubleshooting)。

## 提交训练 {#training}

### 发布后运行

先结束该项目的所有开发终端，不能只断开。回到自己电脑：

```sh
gpuctl project publish
gpuctl project status
```

等本次发布显示 `READY` 后，再单独执行训练；不要把发布和训练连着复制执行：

```sh
gpuctl run -g 1 -- python train.py --output /outputs
gpuctl jobs
```

默认使用最新的 `READY` 版本；新发布失败时直接运行可能用到旧代码。要固定版本，使用 `gpuctl run --release FULL_HASH -g 1 -- python train.py`。

基础 `run -g 1` 默认使用兼容预设 `normal`：节点确认新版策略时为 P2、`yield=never`、`mode=queue`、不自动重跑，只可让明确同意中断的低档 `idle` 任务让位；节点未确认时显示旧策略／未核验。需要明确的让位与恢复约定，使用[自定义调度](/guide/queue)。

`-g` 是申请卡数，`--` 后才是自己的程序参数。示例 `--output` 需按训练程序修改；结果、日志文件和 checkpoint 要写入 `/outputs`。训练的代码和环境只读，改代码后重新上传、安装依赖、退出终端、发布。关闭网页或自己的电脑不会停止服务器训练。

任务信息新版可填写任务名与自写描述，描述最多 2000 字／6000 bytes：

```sh
gpuctl run -g 1 --name baseline --description "验证新数据集，预计两小时" -- python train.py
```

旧客户端不填描述仍能提交，旧任务显示「未填写描述」，不会拿训练命令代替描述。

### 同机多卡

```sh
gpuctl run -g 4 --min-vram 24 -- python -m torch.distributed.run --standalone --nproc-per-node=4 train.py --output /outputs
```

程序本身须支持多卡。平台只在已选服务器分配卡，不改写单卡程序、不把显存合并成一张大卡，也不自动跨服务器训练。

### 弹性卡数与自动扩卡

```sh
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 -- python train.py
```

`-g` 是最大卡数，`--min-cards` 是最少启动卡数；按当前最多的合法空卡启动。合法条件是 global batch 能被「实际卡数 × 每卡 micro batch」整除，梯度累积次数也必须是整数。例中合法卡数为 1、2、4、8；空闲 3 张时启动 2 张。个人额度仍预留最大卡数。

自动扩卡还需要保存让位和恢复：

```sh
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 --auto-expand --rank P1 --yield save --checkpointable --restart-policy on-preempt -- python train.py
```

新空卡出现后先保存、结束旧训练尝试，再从 checkpoint 以更大合法卡数启动，不是热挂显卡。程序要按 `GPUQ_WORLD_SIZE` 的实际卡数启动 DDP，用 `gpuq.elastic.plan_elastic_batch()` 计算累积；不能把 worker 数固定成最大卡数。固定 global batch 时 LR 不自动改变；平台不替代码实现梯度累积、保存或恢复。排队任务优先于扩卡，保存失败不强杀。

### 固定显卡与轻任务共享

先在算力总览观察空位和显存，再选物理卡号：

```sh
gpuctl run --gpu 0,2 -- python train.py
gpuctl run --gpu 3 --share --vram-mib 4096 -- python small.py
```

固定选卡绑定物理 UUID；共享是新任务自己选择同卡运行，可与外部或普通托管任务共存，仅需新提交者同意。共享占 1 张额度，不支持弹性、自动让位、自动恢复或主动抢占；普通共享预算是准入估计，没有硬显存隔离，可能互相影响或 OOM。

节点确实支持 HAMi 时可用：

```sh
gpuctl run --gpu 3 --share --vram-mib 4096 --hami --sm-percent 50 -- python small.py
```

HAMi 只限制这项任务，不限制同卡外部进程，也不保证性能比例；SM 限额需节点额外支持。能力或库缺失会拒绝，不会静默降级。网页有对应的弹性、固定和共享选项。

### 停止一项训练

```sh
gpuctl cancel JOB_ID
```

确认进程、租约和扩卡预留清理后才释放额度；`UNKNOWN` 不等于已停止。取消不是保存 checkpoint，不自动恢复，也不删除已写出的结果。`watch` 中按 Ctrl+C 只退出查看，不会取消任务。

## 数据集 {#data}

### 从网上下载到服务器

当前没有后台 URL 下载按钮。可以打开个人数据终端，使用节点已有的下载工具；是否成功还取决于源站可访问性和数据源授权：

```sh
gpuctl data shell
```

进入数据终端后，用真实下载直链替换 `DATASET_URL`：

```sh
mkdir -p /data2/my-data
cd /data2/my-data
wget -c 'DATASET_URL'
exit
```

`wget` 需节点已安装；续传也需要源站支持。终端连续无输入 1 小时或累计 6 小时会结束，不是无限运行的后台下载队列。下载完成并核对来源校验值，必要时在数据终端解压，结束自己的所有数据终端后，用 `gpuctl data publish my-data --name my-data` 发布，等 `READY` 再训练。

下载回自己电脑是另一条路径：项目文件／训练结果可以 `pull`，当前没有整份已发布数据集的一键下载入口；不要把 `pull --job` 当作数据集下载。

### 上传目录（支持续传）

普通成员可以上传个人数据，不需管理员逐份代传。先选机器：

```sh
gpuctl data upload ./my-data --name my-data
gpuctl data upload-status UPLOAD_ID
```

保持同一目录、机器和名称，重复原上传命令可续传；期间不要修改目录。显示 `READY` 后复制返回的完整数据集 ID、64 位版本和训练路径，ID 可能与输入短名不同。

仅当想放弃未完成上传时执行下面命令；不要跟着正常上传步骤一起运行，不删除就绪版本：

```sh
gpuctl data upload-discard UPLOAD_ID
```

### 上传压缩包，手动整理后发布

网页「数据集 → 个人数据目录」对应的 `/data2` 只对应**你在当前服务器上的可写目录**，不是整块数据盘。CLI 在自己电脑执行：

```sh
gpuctl data put samples.zip
gpuctl data shell
```

进入数据终端后：

```sh
mkdir -p samples
unzip samples.zip -d samples
exit
```

压缩包不会自动解压；先检查来源、解压大小和空间。数据终端没有 GPU；`gpuctl data files` 查看目录，`gpuctl data shell --reconnect SESSION_ID` 重连。上传单文件上限 100 GiB，`put` 暂不自动续传；重新上传覆盖需明确加 `--overwrite`。

结束这台机器上自己的所有数据终端，回到自己电脑发布：

```sh
gpuctl data publish samples --name samples
gpuctl data workspace-status OPERATION_ID
```

发布期间不能修改数据目录；只断开终端不够。显示 `READY` 后用返回的引用训练。发布保留可写目录并生成独立只读副本，需要两份空间；之后修改草稿不影响已发布数据。手工写入尚无独立磁盘硬配额，大规模解压先核对空间。

### 使用数据训练

```sh
gpuctl data list
gpuctl data prepare DATASET_ID@VERSION
gpuctl data status DATASET_ID@VERSION
```

确认所选机器的项目与这份数据都显示 `READY` 后，再运行：

```sh
gpuctl run -g 1 --data DATASET_ID@VERSION -- python train.py --data /data2/DATASET_ID --output /outputs
```

自己的上传已在本机 `READY` 时不必重复准备；「已登记」「准备中」或「未知」不等于就绪。`--` 前的 `--data` 是平台挂载声明，后面的参数由自己的程序处理，路径以平台返回值为准。训练数据只读，缓存和预处理输出写 `/outputs`。

网页和 CLI 都经过平台服务器中转，不是你到 GPU 服务器的高速直连。数百 GB／TB 数据先约定实验室内网或外接硬盘导入。单份清单最多 500,000 条且不超过 64 MiB，空间还受节点和账号限制；平台副本不是备份。

## 日志与结果 {#results}

### 队列、进度和错误

```sh
gpuctl jobs
gpuctl watch JOB_ID
gpuctl logs JOB_ID
gpuctl diagnostics JOB_ID --json
```

`watch` 默认每 5 秒核对，`--interval 1` 可调整；Ctrl+C 只停止查看。完成、失败、取消或状态未知时反馈并退出，断开连接后可再次 `watch`；不会取消、恢复或重试训练。

网页任务表可显示轮次、步数和训练自报 ETA。准确进度需要程序接入 `gpuq.progress.ProgressReporter`；未适配显示「进度未上报」，仍可看日志。训练自报 100% 或异常不是调度终态。`RUNNING` 不保证每个 worker 都健康；先看最近 200 行主日志，再看 worker 诊断、退出原因和历史分配。

任务信息新版还可查询同机成员的公开姓名、任务名和描述：

```sh
gpuctl queue
gpuctl queue --machine MACHINE_ID
```

旧门户先用 `state/jobs`；没有平台记录或进程归属证明时，不猜外部任务的姓名。其他人的命令、日志、结果和操作权限不会开放，采集过期也不能当作空闲。

### Telegram 通知（可选）

先请管理员为你的账号配置 Telegram 收件人，再订阅自己的未结束任务：

```sh
gpuctl notify JOB_ID on
gpuctl notify JOB_ID status
```

网页任务表也有开关，默认关闭。可接收完成、失败、训练自报警告／异常和停滞反馈；`status` 看待发与失败数量。通知失败不改变训练状态，通知可能延迟或重复，实际结果以平台为准。

只在想关闭通知时执行 `gpuctl notify JOB_ID off`，不是订阅后的必做步骤。

### 下载结果

```sh
gpuctl files --job JOB_ID
gpuctl pull --job JOB_ID model.pt ./model.pt
```

保持任务原服务器和项目；不同项目或机器的输出不会自动搬运。已有同名本地文件换个名称，避免覆盖。网页能浏览和下载，超过 100 MiB 的单文件用 CLI；不会自动备份。

### 给任务留言

```sh
gpuctl notes
gpuctl note --job JOB_ID "预计今晚结束"
gpuctl note --general "本周维护安排"
```

网页「协作区 → 任务留言」有相同入口。任务留言只能关联自己的未结束平台任务，平台确认完成、失败或取消后自动清理正文；排队、让位中、状态未知时保留。非任务留言保留到手动删除。作者可用 `gpuctl note-delete NOTE_ID` 删除自己的留言，管理员可删除他人留言。留言对登录成员可见，每条最多 2000 字符；聊天室是另一个入口，不跟随训练结束自动清理。

## 排队与协作 {#queue}

### 等级、被抢占和恢复分别设置

网页展开「提交训练 → 自定义 GPUQ 调度」。P0–P4 越大越优先，普通成员可提交 P0–P2，P3/P4 由管理员使用。低等级不等于同意被中断：

```sh
gpuctl run --rank P1 --yield never -g 1 -- python train.py
gpuctl run --rank P1 --yield now -g 1 -- python disposable.py
gpuctl run --rank P1 --yield save --checkpointable --restart-policy on-preempt -g 2 -- python train.py
```

- `never`：不自动让位。
- `now`：允许立即中断，不保存；默认不自动重跑。
- `save`：当前轮次保存成功后，整个多卡任务让位。
- `--restart-policy on-preempt`：只适用于已适配保存的 `save` 任务，被抢占后排队恢复；手动取消或失败不自动重跑。

`--checkpointable` 是确认已适配，不会改写代码。训练每轮结束调用 `gpuq.checkpoint.checkpoint_at_epoch_end`，启动时读取 `resume_checkpoint_path()`；保存和恢复 model、optimizer、scheduler、进度及各 rank RNG，DDP 所有 rank 协同，保留适配器退出码 75。已启用控制通道的训练内可直接导入 SDK，开发终端没有此通道；保存失败／超时不强杀，恢复文件缺失不从头冒充恢复。

### 请求抢占模式

```sh
gpuctl run --rank P2 --mode preempt1 -g 1 -- python urgent.py
gpuctl run --rank P2 --mode preempt2 -g 1 -- python urgent.py
```

模式 1 只选择明确愿意让位且能保存的低等级任务；模式 2 对 `now` 任务立即让位，对 `save` 任务仍先保存，不越过对方约定。默认 `queue` 也按被抢占任务自己的 now/save 约定调度，不代表占满后永远不能抢占；默认模式、请求模式与自己的被抢占方式是不同选项。

同等级不互抢，`never`、旧 `legacy`、共享和外部进程不被这些新模式强杀。请求的卡数、个人额度和节点能力仍要满足，缺能力会拒绝，不会自动换机或降级。旧 `--priority idle|normal|high` 仍兼容，但不能与上述自定义选项混用；其中 `idle` 允许结束任务，不自动保存或重跑。

管理员可修改已核验待启动任务的排队等级：`gpuctl priority JOB_ID P1`。只改排序，不改让位和恢复，不作用于已运行任务。

### 额度和团队交流

排队、启动、运行和状态待确认的任务都会计入你的额度；弹性任务按最大卡数预留。额度不是物理预留，有额度也可能等卡。不要用瞬时 0% 利用率判断显卡空闲。

「协作区」可说明预计结束时间和协调紧急需求；留言不会自动改变配额、队列或取消任务。反馈问题注明机器、任务 ID、时间和复现步骤，不要粘贴密码、令牌、私钥或私密训练数据。

## 常见问题 {#troubleshooting}

### 同步代码或数据到另一台机器

来源、目标和固定版本由自己选择，先预览：

```sh
gpuctl sync git ./my-repo --ref HEAD --to TARGET --project new-project --dry-run
gpuctl sync code --from SOURCE --to TARGET --project my-project --release FULL_HASH --target-project new-project --dry-run
gpuctl sync data DATASET_ID@VERSION --from SOURCE --to TARGET --name my-data --dry-run
```

将 `SOURCE/TARGET` 换成获授权机器 ID，去掉 `--dry-run` 才传输。Git 仓库须干净并支持 `check-attr --source`，只导出固定提交；已有节点代码只复制固定 release。目标须是新项目，重复同一命令可续传，不覆盖旧项目、不删除目标其他内容。

代码显示 `CODE_READY` 还不能训练：在目标 `use`、`project use`、`ssh` 准备依赖，退出后 `project publish/status`，等 `READY`，使用目标的完整 `--release`。同步不迁移 Conda/venv、草稿或结果。数据使用返回的目标完整 `名称@版本`，内容版本必须一致；这不是自动多机调度，也不是 TB 级高速直传。

### 发布或模型加载失败

发布前结束所有项目开发终端，不能只断开；检查错误提示中属于自己的文件和链接。不要给系统目录批量改权限。训练和开发终端的 HOME 不同，默认缓存不会自动带进训练；模型文件放 `/workspace/offline` 后发布，大模型用数据集。

项目网络检查与一次性代理：

```sh
gpuq-network show
gpuq-network check https://pypi.org/simple/
gpuq-network exec --proxy http://PROXY_HOST:PORT -- python -m pip install -r requirements.txt
```

这些命令在项目开发终端执行。代理地址由管理员提供，不直接照抄宿主机 `127.0.0.1`，不要把含密码代理写进项目或反馈。

### 提交超时、任务 UNKNOWN 或无法取消

先查 `jobs/watch`、日志和诊断。`UNKNOWN` 不表示已结束，额度仍保留；不要重复建任务或删目录。提交重试用原输出的 `Submission key`，加原 `--key UUID`、同一个完整 `--release` 和原参数，不能换策略重试。仍无法确认就把任务 ID 交给管理员。

### 申请系统维修

普通项目终端不能改全局系统。需要安装系统库或维修时，在网页「维护申请」填写机器、原因和脚本，或在自己的电脑执行：

```sh
gpuctl maintenance request --name "检查系统依赖" --reason "缺少系统库，需要检查" --script-file ./maintenance.sh
gpuctl maintenance list
gpuctl maintenance show REQUEST_ID
```

文件内容冻结在申请里，不立即执行，也不给你 root。管理员之后批准执行或附必填理由退回。仅当主动撤回自己的待确认申请时，执行 `gpuctl maintenance withdraw REQUEST_ID --revision N`，`N` 用 `show` 返回的版本替换；不要跟在正常申请步骤后执行。

修改后新建申请，可加 `--parent REQUEST_ID` 引用旧记录。关闭网页不停止已批准操作，状态和输出回到原申请；停止、失败均不回滚。响应不明保留原提交键，`UNKNOWN` 不得换键盲目重跑。

原有系统账号、原生 SSH、Tailscale 是独立入口，平台注册不授予这些权限。没有功能入口或节点能力时请管理员升级，不假装维修已经执行。

### 登录过期或换账号

`gpuctl login` 重新登录，`gpuctl logout` 主动退出；换账号后重新选服务器和项目。
