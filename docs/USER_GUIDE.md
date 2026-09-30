# 使用指南

在自己的电脑上写代码，在平台选择服务器、申请显卡并运行训练。网页和命令行使用同一个账号，共享项目与任务。

## 首次使用 {#start}

### 注册与获取额度

打开平台，使用管理员提供的注册码注册用户名和密码。**不需要 ChatGPT 账号，不需要安装 Tailscale，也不需要服务器的 SSH 密钥。** 换电脑时，登录同一个平台账号即可。

新账号的用卡额度为 0。管理员批准可用服务器和卡数后，你就可以创建项目、上传数据和提交训练；等待授权期间可以查看公告、参与交流。

### 找到要用的服务器

在“算力总览”查看服务器型号、每张卡的显存与使用情况。复制你获准使用的**机器 ID**，后面的 `MACHINE_ID` 都要换成它；不要照抄其他人的服务器名称。

你来选服务器，平台在这台服务器上分配显卡。切换服务器不会自动搬运代码、环境、数据或结果。

### 网页怎么用

- **我的工作台**：选服务器、管理项目、打开开发终端、发布版本、提交和查看训练。
- **算力总览**：看各台服务器的显卡资源、占用和最近更新时间。
- **数据集**：上传自己的数据，或准备已获授权的数据版本。
- **协作区**：阅读维护公告、反馈问题、与其他成员协调排队。

不想安装客户端，可以直接在网页完成这些操作。使用本地 VS Code 等编辑器时，下面的命令行流程更方便。

### 安装命令行客户端

自己的电脑需要 **Node.js 22.13 或更高版本**；先安装 Node.js，再重新打开终端。Windows 可直接使用 PowerShell，**不需要 WSL**。按自己的系统选择一组安装命令。

**Windows PowerShell：**

```powershell
node --version
$installer = Invoke-WebRequest 'https://gpu.example.com/install.ps1' -UseBasicParsing -MaximumRedirection 0
& ([scriptblock]::Create($installer.Content))
```

命令从本平台下载并运行安装器，只安装到你的用户目录，不需要管理员权限，不修改 PowerShell 执行策略。如果单位的安全策略阻止执行，请联系本机管理员，不要自行关闭安全策略。

**macOS、Linux 或已有的 WSL：**

```sh
node --version
curl -fsSL https://gpu.example.com/install.sh | sh
```

安装后重新打开终端，登录并选择服务器：

```sh
gpuctl login
gpuctl state
gpuctl use MACHINE_ID
```

按提示输入平台用户名、密码；密码不回显是正常的。`state` 可查看账号资源，`use` 会记住你选择的服务器。日常使用不必反复登录。

下一步：[创建项目、上传代码和安装依赖](/guide/development)。

## 项目开发 {#development}

### 创建项目并上传代码

在**自己电脑的代码目录**打开终端：

```sh
gpuctl project create my-project
gpuctl push .
gpuctl ssh
```

项目名用小写英文字母开头，可包含数字、下划线、连字符，最长 48 个字符。项目创建后会自动选中；下次继续已有项目用 `gpuctl project use my-project`。查看项目列表用 `gpuctl project list`。

`push .` 将当前目录上传到选中项目。它会跳过常见本地环境和秘密文件，例如 `.venv`、`.git`、`.ssh`、`.env`，但**不能识别所有敏感文件**；上传前请检查目录。不要上传本机 Python 环境或把大数据集混进代码目录。

上传会更新同名文件，不会删除服务器上多余的旧文件。若本地删除了代码文件，需要在开发终端核对并清理对应的旧文件。

### 安装依赖

`gpuctl ssh` 打开的是服务器上的个人项目终端，进入后执行：

```sh
python -m pip install -r requirements.txt
python -m pip check
exit
```

没有 `requirements.txt` 时，按项目需要安装 Python 包。代码在 `/workspace`，项目 Python 环境在 `/opt/project-env`。安装只影响这个项目，不覆盖其他人的环境；关闭终端也不会删除文件。

默认项目可使用服务器已有的基础 Python 包。如果需要从空的 Python 包环境开始，请**新建项目时**选择隔离模式：

```sh
gpuctl project create clean-project --env-mode isolated
```

隔离模式需要自行安装 PyTorch 等依赖。它是 Python 包隔离，不是可随意修改系统的完整容器；目前个人项目终端不能使用 `sudo apt` 安装系统软件。缺少系统库时请联系管理员。

### 多个终端与重连

每次 `gpuctl ssh` 都会**新建独立终端**，不会自动接回之前的会话。它通过 HTTPS 连接，不是原生 SSH 地址，不能直接填入 VS Code Remote-SSH、SFTP 或 rsync。

- 输入 `exit`：结束这个终端。
- 按 `Ctrl+]`，或网页点击“断开”：仅断开连接，终端继续运行。
- 要接回原终端：复制断开提示中的完整重连命令，或使用下面的命令。

```sh
gpuctl ssh --reconnect SESSION_ID
```

将 `SESSION_ID` 换成原会话编号，并保持同一服务器、同一项目。若另一客户端仍在操作它，先与对方协调；确实需要取代该连接时才加 `--takeover`。

开发终端**没有 GPU**，用于编辑、安装和 CPU 检查。单终端限 2 核 CPU 额度、8 GiB 内存，连续无输入 1 小时或累计运行 6 小时会结束。CUDA 检查和训练都应[提交训练任务](/guide/training)。

## 提交训练 {#training}

### 发布一个可运行版本

训练使用固定的代码和环境版本，不直接读取正在编辑的草稿。先结束这个项目的**所有开发终端**：CLI 用 `exit`，网页用“结束终端”；仅断开连接不够。

回到**自己电脑的终端**：

```sh
gpuctl project publish
gpuctl project status
```

等本次发布显示 `READY` 后再提交。发布期间不占 GPU；大环境需要等待，查看状态即可，不必重复发布。

### 运行单卡训练

```sh
gpuctl run -g 1 -- python train.py --output /outputs
gpuctl jobs
```

`-g 1` 申请 1 张卡，`--` 后是你自己的训练命令。示例中的 `--output` 是 `train.py` 的参数，按你的程序修改；**结果、日志文件和 checkpoint 要写入 `/outputs`**。训练中的代码目录 `/workspace` 和环境是只读的。

提交成功后记下返回的任务 ID。关掉浏览器或自己的电脑不会终止训练；等待显卡时任务进入队列。

**代码改了，要重新上传并发布。** `gpuctl run` 不会自动上传本地修改，默认使用最新的 `READY` 版本。若本次发布失败，而以前还有可用版本，直接运行可能用到旧代码；提交前核对发布状态与版本。

日常修改的顺序是：保存代码 → `gpuctl push .` → 必要时安装依赖 → 结束开发终端 → 发布到 `READY` → 提交训练。新加的数据集还需[在训练机器上准备就绪](/guide/data)。

### 多卡训练

```sh
gpuctl run -g 4 --min-vram 24 -- python -m torch.distributed.run --standalone --nproc-per-node=4 train.py --output /outputs
```

这会在**同一台服务器**申请 4 张卡，每张至少约 24 GiB 物理显存。程序本身必须支持多卡；平台不会自动改写单卡代码，也不会将几张卡的显存合成一张大卡，或自动启动跨服务器训练。

### 停止任务

```sh
gpuctl cancel JOB_ID
```

把 `JOB_ID` 换成平台返回的任务 ID。确认进程结束后才释放额度，已经写入的结果仍保留。取消不是保存训练状态，是否能续训取决于你的程序是否写出了 checkpoint。

## 数据集 {#data}

### 上传自己的数据

普通成员可以上传个人数据，不需要管理员代为创建数据集。先选好已获授权的服务器，在自己的电脑执行：

```sh
gpuctl data upload ./my-data --name my-data
```

名称使用 1–40 位英文字母、数字、下划线或连字符，以字母或数字开头。网页也可以在“数据集”中选择本机目录上传。

上传结束并显示 `READY` 才能用于训练。复制返回的**完整数据集 ID、完整版本和训练路径**；个人数据集 ID 与输入的短名称可能不同。上传不占 GPU，也不会自动复制到其他服务器。

网络中断时，保持同一机器、名称和目录，重复原命令即可续传。上传期间不要修改目录。查看进度或放弃未完成上传：

```sh
gpuctl data upload-status UPLOAD_ID
gpuctl data upload-discard UPLOAD_ID
```

`UPLOAD_ID` 使用原上传返回的编号。放弃上传不会删除已经就绪的数据集；删除已就绪版本请联系管理员。

### 上传压缩包，自己解压整理

在“数据集 → 个人数据目录”上传压缩包，再打开“个人数据终端”。这里的 `/data2` 只对应**你在当前服务器上的可写目录**，不是整块服务器磁盘；其他用户的数据、已发布版本和 GPU 都不可见。

也可以在自己电脑上执行：

```sh
gpuctl data put samples.zip
gpuctl data shell
```

进入数据终端后：

```sh
mkdir -p samples
unzip samples.zip -d samples
# tar.gz 格式则使用：tar -xzf samples.tar.gz -C samples
exit
```

解压前检查压缩包来源和展开后的大小。文件保留在 `/data2`，退出终端不会删除；需要时可自行整理、预处理、删除自己的临时文件。数据终端与项目开发终端是独立入口，没有 GPU；不要在这里跑训练。

结束这台机器上自己的**所有数据终端**后，回到自己电脑发布整理好的子目录：

```sh
gpuctl data publish samples --name samples
gpuctl data workspace-status OPERATION_ID
```

`OPERATION_ID` 用发布命令返回的编号替换。网页有同样的发布入口。发布在服务器后台扫描、复制和校验；显示 `READY` 后使用返回的数据集 ID 和版本提交训练。发布期间不能继续修改个人数据目录；只“断开”终端不够，需要 `exit` 或“结束终端”。发布生成独立只读副本，之后修改个人目录不会影响已发布数据。

`gpuctl data files` 查看目录；`gpuctl data shell --reconnect SESSION_ID` 重连。单文件上传上限 100 GiB，压缩包不会自动解压；中断后检查远端文件，用 `gpuctl data put samples.zip --overwrite` 明确覆盖重传，此入口暂不自动续传。原来的 `data upload` 目录上传仍支持续传。

### 大数据如何传

网页和 CLI 上传都会经过平台服务器中转，**不是你到 GPU 服务器的高速直连**。数百 GB、TB 级或大量小文件，先与管理员约定通过实验室内网或外接硬盘导入，再由管理员登记、校验并授予使用权限。不要把大数据集当项目代码上传。

需要手动解压时使用个人数据目录，不要把大压缩包上传到项目代码区。发布会保留可写原目录并生成只读副本，需预留两份数据的空间。个人数据终端的手工写入尚无独立磁盘硬配额；空间是共享资源，大规模解压前请先与管理员确认，完成后清理不再需要的压缩包和临时副本。

单份数据清单最多 500,000 个文件和目录条目，且清单本身不超过 64 MiB；实际可上传容量还受账号和节点剩余空间限制。保留自己的原始数据，平台副本不等于备份。

### 使用已有的数据集

先看自己能用的固定版本，在选中的训练机器准备本地副本：

```sh
gpuctl data list
gpuctl data prepare DATASET_ID@VERSION
gpuctl data status DATASET_ID@VERSION
```

把 `DATASET_ID@VERSION` 整段替换为列表中的真实值，版本必须是完整的 64 位版本号。自己的上传已是本机 `READY` 时，不必重复准备。显示“已登记”“准备中”或“未知”都不代表能开始训练。

### 在训练中读取

项目版本和所选数据版本都就绪后：

```sh
gpuctl run -g 1 --data DATASET_ID@VERSION -- python train.py --data /data2/DATASET_ID --output /outputs
```

替换数据集 ID、版本和程序参数，路径以平台返回的值为准。`--` 前的 `--data` 告诉平台挂载哪份数据，后面的 `--data` 是示例训练程序的参数。

训练只读本机的数据副本。预处理产物和缓存索引写 `/outputs`，不要写回数据集。普通开发终端不会自动挂载数据集。切换机器后，需要重新检查该机的数据与项目版本是否就绪。

## 日志与结果 {#results}

### 查看进度与错误

网页在任务列表打开“日志”，或在自己的电脑执行：

```sh
gpuctl jobs
gpuctl logs JOB_ID
gpuctl diagnostics JOB_ID --json
```

`jobs` 查看最近任务，`logs` 查看主日志最近 200 行。需要排查分布式训练时，诊断包提供已采集到的 worker 错误、退出原因、资源峰值和历史 GPU 分配；网页日志窗口也可查看和下载。

任务显示 `RUNNING` 只说明主进程仍在运行，不保证每个 worker 都健康。主日志停住或训练没有进展时，先看诊断包；缺失或“未知”表示没有采集到，不能当作没有错误。

### 下载结果

```sh
gpuctl files --job JOB_ID
gpuctl pull --job JOB_ID model.pt ./model.pt
```

第一条列出该任务的结果文件，第二条下载其中的 `model.pt` 到当前电脑。将文件名换成实际输出；如本地已有同名文件，请换一个目标名称，避免覆盖。

网页也能浏览、下载结果；大于 100 MiB 的单文件请使用 CLI。结果保存在任务运行的服务器，不会随切换机器移动，也不会自动备份。训练任务的 `/outputs` 与开发终端的临时 `/outputs` 是两个不同位置。

### 反馈问题

到“协作区 → 问题反馈”提供机器 ID、任务 ID、出错时间、操作步骤和相关错误片段。共享诊断前检查内容，不要粘贴密码、令牌、私钥或私密训练数据。

## 排队与协作 {#queue}

### 授权不等于占住显卡

每台机器的卡数上限限制你在该机同时申请多少张卡；所有机器合计上限限制你跨机器同时申请的总卡数。例如每台最多 4 张、总共最多 6 张，可以一台申请 4 张，另一台申请 2 张。

排队、启动、运行和状态待确认的任务都会计入你的额度。额度足够但机器没有可用卡时仍需排队；它不是物理显卡预留，也不会把你的任务自动送到其他服务器。

### 选择合适的优先级

- **普通 `normal`**：默认选择，正常排队，不因后来提交的任务自动被中断。
- **最低、可中断 `idle`**：利用空闲资源；需要给更高档任务让位时，训练可能被结束。
- **高 `high`**：管理员使用，用于优先安排任务。

```sh
gpuctl run -g 1 --priority idle -- python disposable_trial.py --output /outputs
```

**最低档不是“运行慢一点”，而是允许结束任务来让位。** 被中断后保留已写出的结果，不自动重跑，也不替程序生成 checkpoint。只给可丢弃或可自行恢复的实验使用这一档。

任务优先级不保证准确开跑时间。查看队列与最近状态，不要仅凭一张卡的利用率暂时为 0 判断它能立即分配。

管理员可在任务表调整已核验、尚未启动任务的 P0–P4 排队等级，也可执行 `gpuctl priority JOB_ID P1`（例如 P1 或 P3）。此操作只改变排队顺序，不改变原任务的让位、保存和恢复约定，也不要求重新确认让位。节点尚未支持独立改等级时，入口不可用；运行中任务不能这样修改。

### 自定义等级、让位与恢复

网页展开“提交训练 → 自定义 GPUQ 调度”。P0–P4只改变排序，不表示同意中断；成员可选P0–P2。节点缺能力时明确拒绝，不降级。

```sh
gpuctl run --rank P1 --yield never -g 1 -- python train.py
gpuctl run --rank P1 --yield now -g 1 -- python disposable.py
gpuctl run --rank P1 --yield save --checkpointable --restart-policy on-preempt -g 2 -- python train.py
```

`save`须训练适配checkpoint并恢复完整状态，DDP所有rank协同。低等级save任务整体保存后让位，on-preempt随后排队恢复；保存失败不强杀，手动取消或失败不自动重跑。`--checkpointable`不是自动改写代码。

请求方可主动选抢占1/2；自己的rank、是否愿意被中断、之后是否恢复仍是独立选择。

```sh
gpuctl run --rank P2 --mode preempt1 -g 1 -- python urgent.py
gpuctl run --rank P2 --mode preempt2 -g 1 -- python urgent.py
```

模式1只选愿意让位且能保存的低等级任务；模式2对now任务立即让位，但save任务仍先保存。
旧任务、never、共享或外部进程不会被新模式强杀；同等级不互抢。节点缺新能力时明确拒绝，
`queue`或省略mode保留旧默认格式，同key重试不能换成不同抢占模式。

### 协调使用安排

“协作区”包含维护公告、问题反馈和公共交流。可以说明预计结束时间、协商释放资源或说明紧急实验，但聊天约定不会自动改变配额、队列或取消任务。

后台启用任务留言后还会显示“任务留言”：先选择“随任务结束删除”并关联自己的任务，或选择“非任务留言，手动删除”。支持刷新、编辑和删除；发送结果不确定时重试原内容。旧后台未启用时不显示此入口，原有协作功能照常使用。

协作内容对所有已登录成员可见；长期实验记录请保存在自己的项目或文档中。维护前及时保存 checkpoint，是否自动保存由训练程序决定。

### 任务留言（命令行）

```sh
gpuctl notes
gpuctl note --job JOB_ID "预计今晚结束"
gpuctl note --general "本周维护安排"
gpuctl note-delete NOTE_ID
```

任务留言使用 `gpuctl jobs` 返回的完整平台任务 ID，只能关联自己的未结束任务；确认完成、失败或取消后自动删除正文。排队、让位中或状态未知时保留。`--general` 是非任务留言，保留直到作者或管理员手动删除。所有登录成员可见，每条最多 2000 字符；这套 API/CLI 不改变网页原有聊天室的留存规则。

## 常见问题 {#troubleshooting}

### 刚注册，为什么没有可用显卡？

新账号从 0 额度开始，请管理员批准服务器与卡数。如果已有额度仍提示超限，检查自己的排队任务，它们也计入额度。不要重复提交相同任务。

### 本地改好了，训练为什么还是旧代码？

本地修改不会自动同步。确认上传到正确机器、正确项目，并且**这一次**发布已经 `READY`。新发布失败时，旧的可用版本可能仍被默认选中。按[提交训练](/guide/training)重新核对。

### 发布提示终端还在使用，或文件不能读取？

结束该项目所有开发终端，不能只断开。文件错误先看提示里的相对路径，检查是否仍在写入、没有读取权限或含软链接、硬链接；只处理确认属于自己项目的文件，不要对系统目录批量改权限。

### 终端断线后怎么接回？

使用原终端的会话 ID 显式重连。直接再运行 `gpuctl ssh` 会创建新终端；`exit` 结束的终端不能重连。需要接管正在被另一个客户端使用的会话时，先协调再使用 `--takeover`。详见[项目开发](/guide/development)。

### pip 安装失败，或训练找不到下载过的模型？

先在项目开发终端区分网络与包依赖问题：

```sh
gpuq-network show
gpuq-network check https://pypi.org/simple/
```

如确实需要代理，请管理员提供能从项目访问的地址；不要直接照抄宿主机的 `127.0.0.1`。只为一次安装设置代理的例子：

```sh
gpuq-network exec --proxy http://PROXY_HOST:PORT -- python -m pip install -r requirements.txt
```

将示例地址换成获准的实际地址，含密码的代理不要写入代码、发布包或反馈帖子。

训练和开发终端的 HOME 不同，开发时默认缓存的模型不会自动进入训练。把所需文件明确放进项目的 `/workspace/offline` 后发布，并在程序中用本地路径加载；大模型走数据集渠道。不要复制整个登录缓存，也不要在占用 GPU 时临时安装依赖。

### 任务一直运行、状态未知或提交超时？

先查 `gpuctl jobs`、日志和诊断包。`UNKNOWN` 表示平台暂时无法确认，不代表已停止，额度会保留。不要靠重复提交或删目录处理；把任务 ID 和错误交给管理员。

提交响应超时时，先核查是否已有任务。需要重试时，使用原输出的 `Submission key`，加 `--key` 和同一完整 `--release` 版本、同样的训练参数，避免产生第二份任务。

### 能直接在服务器装软件、使用已有系统账号吗？

平台个人终端支持项目内开发和 Python 依赖安装，不提供整台服务器的管理权限；需要系统包或特殊工具时联系管理员。原有服务器账号、Tailscale 和原生 SSH 是另一套入口，不会因为注册平台而自动获得。

### 登录过期或换账号怎么办？

执行 `gpuctl login` 重新登录；主动退出用 `gpuctl logout`。换账号后重新选服务器和项目。入口、可用机器和授权以当前平台显示为准。
