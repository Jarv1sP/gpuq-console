# 使用指南

网页和 `gpuctl` 共用账号、项目与任务。下面只说明日常用法；入口是否可用，以当前门户和节点能力为准。

## 首次使用 {#start}

### 注册、安装与选机器

打开平台，用管理员提供的注册码注册。新账号的用卡额度为 0；管理员授权服务器和卡数后才能训练。用户电脑不需要安装 Tailscale，也不需要服务器 SSH 密钥。

仅使用网页无需安装客户端或 Node.js。使用命令行时，自己的电脑需要 Node.js 22.13 或更高版本。Windows 可直接使用 PowerShell，不需要 WSL；从平台下载安装客户端：

```powershell local
node --version
$installer = Invoke-WebRequest 'https://gpu.example.com/install.ps1' -UseBasicParsing -MaximumRedirection 0
& ([scriptblock]::Create($installer.Content))
```

macOS、Linux 或已有 WSL：

```sh local
node --version
curl -fsSL https://gpu.example.com/install.sh | sh
```

将 `https://gpu.example.com` 换成自己的平台地址。安装只写用户目录；不需要管理员权限，不修改 PowerShell 执行策略。安装或更新后重新打开终端；客户端更新使用同一安装命令。

```sh local
gpuctl login
gpuctl state
gpuctl use MACHINE_ID
```

按提示输入用户名和密码。`MACHINE_ID` 从平台复制真实的机器 ID，后面的 `JOB_ID`、`SESSION_ID` 和版本号也都要换成实际值。`use` 记住当前服务器；切换服务器不会自动搬运代码、环境、数据或结果。

### 网页入口

- 我的工作台：选机器、创建项目、开发终端、发布和提交训练。
- 算力总览：逐卡占用和采集时间；未知或过期不代表空闲。
- 数据集：个人上传、数据终端、版本与准备进度。
- 传输任务（管理员启用后）：固定数据集复制、核对进度、终止和恢复。
- 协作区：公告、交流和任务留言。

### 姓名与描述（需任务信息新版）

只有门户和客户端支持任务信息新版时，才有「设置姓名」「任务描述」和全队列查询。没有这些入口可先用 `gpuctl state`、`gpuctl jobs`，请管理员升级；不要把指南更新当作功能已经上线。

```sh local
gpuctl profile --display-name "张三"
```

注册时也可填写姓名。未设置时显示用户名，登录账号和权限不变。新任务保存提交时姓名，旧任务没有姓名快照时使用现有姓名；描述由自己填写，同机器授权成员可见，不要填写密码或令牌。

## 项目开发 {#development}

### 上传代码和安装依赖

在自己电脑的代码目录执行：

```sh local
gpuctl project create my-project
gpuctl push .
gpuctl ssh
```

项目文件上传中断时，保留原文件和远端文件名，重复同一条 `gpuctl push` 会先核对上传身份并从已确认的字节继续；不会自动发布或提交训练。只检查、不继续传输可用 `gpuctl push-status 本机文件 远端文件名 --json`。`COMPLETE` 表示该文件已完整校验；若同时有 `completionPending:true`，再运行原 `push` 完成回执收尾，不会重传内容。项目中某个旧版本 `READY` 不代表本次上传完成。

如果提示目标被修改、上传身份冲突或旧上传缺少安全恢复记录，停止重试并联系管理员；不要换名字绕过。上传期间不要在个人终端或容器内同时修改同一路径：目标变化检测不等于对终端写入加锁，正常 `push` 本身会替换目标文件。单个项目文件最多 4 GiB，完整恢复核验需要读取一次目标文件，大文件或慢盘可能需要等待；数据集仍用数据上传流程。

文件已在该服务器个人数据区时，可用 `gpuctl project import 源目录 新目标目录` 直接复制到本项目草稿，不绕门户传字节。两个路径相对，目标须新建、父目录已存在；先结束项目和个人数据终端。`gpuctl project import-status UUID` 等到 `IMPORTED` 后再编辑依赖和发布。任意宿主路径和只读数据集不支持。停止用 `project import-cancel UUID`；UNKNOWN 保留原 UUID，不换新操作。

旧上传卡住且本机原文件找不到时，`gpuctl project uploads` 查看 UUID，再 `gpuctl project upload-cancel UUID`。只清理确认尚未提交的临时上传，不删除项目代码；提交结果不明或目标变化时仍需按原操作核查。

进入项目终端后执行：

```sh project
python -m pip install -r requirements.txt
python -m pip check
exit
```

代码在 `/workspace`，私人环境在 `/opt/project-env`。默认继承基础 Python 包；需要空环境时新建 `gpuctl project create clean-project --env-mode isolated`。项目名以小写字母开头，可含数字、下划线和连字符，最长 48 字符。

### 个人容器

在网页「新建项目」选择「个人容器」，或在管理员已启用的节点使用 `gpuctl project create system-project --env-mode oci`。没开通的服务器会直接拒绝，不影响你已有的项目。页面上没有「个人容器」选项，就说明你的账号或这台服务器还没开通。

- 用项目的「新建开发终端」进入；容器内 root 不是服务器 root，开发阶段无 GPU，可以在自己的容器安装 apt 等系统包。同一项目只保留一个开发终端，再次进入应明确重连。
- 发布前先结束所有开发终端；「断开」会保留终端，不能用于发布。只有本次发布已确认，才显示训练版本已生成；结果未确认时先重新查询，不另发新的发布请求。
- 先选好要训练的版本；训练固定该镜像版本并只见调度分配的 GPU，之后修改容器不会改动已经提交的训练。

### 工作区与依赖

个人容器的最短流程如下；已有项目不会自动改成容器：

```sh local
gpuctl project create my-container --env-mode oci
gpuctl shell
```

在个人容器内安装依赖、编辑代码，然后 `exit` 返回本机终端。发布环境与代码：

```sh local
gpuctl project publish
```

确认发布完成后提交训练：

```sh local
gpuctl run -g 1 -- python train.py
```

`projects.list` API 的 `environmentModes` 列出当前账号在该机器可选择的环境模式；这是授权能力，不代表公共网络或某个软件包已经可用。开发终端不占卡，只有 `run` 经平台排队分配 GPU。个人容器目前每个项目只能同时打开一个开发终端；重连原终端或关闭后再新开，环境仍保留。

管理员开通磁盘硬配额后，可用 `gpuctl project quota --machine MACHINE_ID` 查看本人实际 byte/inode 用量、上限和剩余。这里的 inode 是文件和目录的计数，不是用卡额度。显示“未启用”或查询失败不代表零用量或无限容量；数据目录与工作区在同一个物理卷时共用该卷的个人硬上限。

项目终端的 `$HOME` 是可写的 `/home/gpuq`，其缓存与私人环境使用平台工作区磁盘。shared/isolated Python 模式的 `/tmp` 是计入内存限制的临时文件系统，不是额外磁盘容量；个人容器默认 `/tmp` 在容器可写层，占用工作区磁盘，是否有个人硬配额取决于节点配置。大包构建可在项目终端把临时文件放到私人 HOME，安装完成后自行清理不再需要的临时文件：

```sh project
mkdir -p "$HOME/.cache/build-tmp"
TMPDIR="$HOME/.cache/build-tmp" python -m pip install -r requirements.txt
```

继续已有项目用 `gpuctl project use my-project`；查看项目用 `gpuctl project list`。`push .` 跳过常见环境和秘密文件，但不能识别所有敏感内容，上传前自己检查；不会删除服务器多出来的旧文件，也不会登记或发布数据集、替你迁移本机环境。它不会自动排除数据目录，不要把数据集混进代码目录。

个人预训练权重、tokenizer 和模型配置放在项目 `/workspace/weights` 或 `/workspace/models`（tokenizer 也可放 `/workspace/tokenizers`），随项目发布成只读的固定输入，训练从本地路径读取。已经在服务器项目中的这些文件不用每次从电脑重新上传；发布可能在服务器内部复制快照，这与电脑上传不同。新训练产生的 checkpoint 和其他输出仍写每个任务独立的 `/outputs`，不要覆盖输入权重。

### 终端断开与重连

每次 `gpuctl ssh` 都会**新建独立终端**。它走 HTTPS，不是原生 SSH，不能直接填入 VS Code Remote-SSH、SFTP 或 rsync。

- `exit` 或网页「结束终端」：结束会话；`exit` 结束的终端不能重连。
- `Ctrl+]` 或网页「断开」：只断开连接，会话继续运行。
- 重连原会话：使用原服务器、项目及会话 ID；另一客户端仍在操作时，明确协调后才用 `--takeover`。

```sh local
gpuctl ssh --reconnect SESSION_ID
```

连接中断或输入回执丢失时，网页显示「输入未确认，未自动重发」，暂停输入，直到你明确重连。先检查输出再决定下一条命令；接管会让另一处失去输入权，已发出的命令不能撤回。连接过期时也要重连，不会新建替代终端。

开发终端**没有 GPU**，限 2 核 CPU 额度、8 GiB 内存；连续无输入 1 小时或累计 6 小时结束。CUDA 检查也应提交训练任务。Python 模式可安装个人包，不能修改基础 Conda 或宿主系统；容器模式只修改自己的容器环境。缺少系统依赖时按[常见问题](/guide/troubleshooting)联系管理员。

## 提交训练 {#training}

### 发布后运行

! 先结束所有开发终端，不能只断开。

```sh local
gpuctl project publish
gpuctl project status
```

#### READY 后运行

```sh local
gpuctl run -g 1 -- python train.py --output /outputs
gpuctl jobs
```

等本次发布显示 `READY` 后再单独运行训练，不要把发布和训练连着复制执行。

默认使用最新的 `READY` 版本；新发布失败时直接运行可能用到旧代码。要使用指定版本，使用 `gpuctl run --release FULL_HASH -g 1 -- python train.py`。

### 自动选择训练服务器

个人容器项目发布后，可以让平台在你有权限的机器中选择。当前开发服务器和项目保持不变，只给运行命令增加 `--machine auto`：

```sh local
gpuctl run --machine auto -g 2 --min-vram 24 -- python train.py --output /outputs
```

平台优先选择个人剩余额度足够、当前有足够空闲卡的兼容机器，再比较项目、数据是否已在本地；管理员免个人累计用卡额度，仍按实际空闲情况选机。需要搬运时先准备代码、容器环境和数据，期间不占 GPU。若所有兼容机器都忙，会在选定机器排队；空闲状态可能变化，不保证立即启动。选定后不会因忙碌、断线或重启偷偷换机。`gpuctl jobs` 可查看最终机器；输出仍保存在那台机器。

网页在「提交训练 → 训练位置」选择「自动选择空闲服务器」。顶部服务器仍是开发工作区，不随训练目标改变；提交回执显示最终训练服务器。默认的「当前服务器 · 自动分卡」则只在手选机器内选卡。

只考虑某几台机器时，增加 `--candidates MACHINE_A,MACHINE_B`，或填写网页的候选服务器；`--on auto` 与 `--machine auto` 等效。自编 CUDA 扩展不一定跨显卡型号兼容，不确定时只选已验证的机器。未启用跨机容器能力、旧共享环境或没有 READY 项目版本时会明确拒绝，原来手选机器的命令继续可用。自动选机不等于跨服务器多卡训练，也不迁移正在运行的开发终端。

手动复制一个固定的个人容器版本可用 `gpuctl project copy 项目名 --from SOURCE --to TARGET --release FULL_HASH`，随后 `gpuctl project copy-status COPY_ID` 查看进度。它只准备训练版本，不覆盖目标开发草稿；取消复制使用 `project copy-cancel COPY_ID`。

复制明确失败或取消后，排查原因，再用 `gpuctl project copy-retry COPY_ID` 显式重试。平台先确认旧 worker 已停止、传输临时文件已清理，才建立同来源、同目标、同版本的新操作；不会自动无限重跑。保留打印的重试键，响应不明时加原 `--key UUID` 重复这条命令；`UNKNOWN` 只能先查状态，不能强行重试。复制恢复就绪后再重新提交失败的训练，旧训练不会自动重启。

停用账号或收回机器权限后，后台在下一次状态检查中先撤销来源下载凭证，再停止和清理目标复制；这不是零延迟操作。节点离线时会保留待清理状态，不把“尚未确认停止”显示成“已清理”。

```sh local
# 从 jobs 显示的实际执行机器下载本次结果
gpuctl pull --machine TARGET --project my-project --job JOB_ID result.pt ./result.pt
```

### 退出项目终端后同步运行

先选好服务器和个人项目，准备服务器环境，并退出该项目的开发终端。再在电脑代码目录运行同步，合并上传、发布和等待。

```sh local
gpuctl run --sync -g 1 -- python train.py --output /outputs
```

也可以明确指定本地目录；Windows PowerShell 和命令提示符均用双引号包住含空格的路径，无需 Bash、rsync 或 WSL：

```powershell local
gpuctl run --sync --sync-dir "C:\研究代码\我的项目" --project my-project -g 1 -- python train.py --output /outputs
```

`--sync` 复用 `push` 的分块上传与 SHA256 校验，然后按本次发布的 UUID 等待 READY 回执，并核对不可变版本清单中的已上传文件；只提交这个版本，不回退到以前的 READY。上传失败、本地文件中途变化、发布失败／状态未知、并发发布替换、校验不一致或等待超时（最多两小时）都会停止，**不提交训练**。它不会替你结束终端、安装依赖或变更权限；默认不切机，明确加 `--machine auto` 时仍先在当前开发服务器发布，再自动选择训练服务器。旧节点尚不支持发布确认时，在上传前明确拒绝。

这是现有代码上传流程的快捷入口，**不是增量镜像或删除同步**：文件按完整校验和上传或续传；已有匹配上传回执的完整文件会核验后复用，与 `push` 相同的秘密／环境目录会跳过，远端多余文件保留；空目录或全部被排除时不会发布旧草稿。不要把数据集混在代码目录中。服务器已有的小体积 `weights/` 可以保留，不必为本命令重新搬回电脑；发布可能在服务器内部复制代码和环境。`--sync` 不能与 `--release`、`--legacy` 或管理员宿主模式合用。

若最后提交请求断线，先用 `gpuctl jobs` 核对输出的 Submission key；不要换新键盲目再运行。发布进程不会因为本地命令退出而被强行结束，进度和失败原因仍可通过 `gpuctl project status` 查看。

带数据集提交时，可以先准备数据再训练。`PREPARING_DATA` 表示正在准备所选机器的本地数据，暂不占 GPU 额度；全部就绪后重新核验项目、授权和额度，才进入显卡队列。没有可用来源或权限不足时拒绝提交，不会偷偷换机器。取消等待中的训练不会取消可能被其他任务共用的数据准备。

基础 `run -g 1` 默认使用兼容预设 `normal`：节点确认新版策略时为 P2、`yield=never`、`mode=queue`、不自动重跑，只可让明确同意中断的低档 `idle` 任务让位；节点未确认时显示旧策略／未核验。需要明确的让位与恢复约定，使用[自定义调度](/guide/queue)。

`-g` 是申请卡数，`--` 后才是自己的程序参数。示例 `--output` 需按训练程序修改；结果、日志文件和 checkpoint 要写入 `/outputs`。训练的代码和环境只读，改代码后重新上传、安装依赖、退出终端、发布。关闭网页或自己的电脑不会停止服务器训练。

任务信息新版可填写任务名与自写描述，描述最多 2000 字／6000 bytes：

```sh local
gpuctl run -g 1 --name baseline --description "验证新数据集，预计两小时" -- python train.py
```

旧客户端不填描述仍能提交，旧任务显示「未填写描述」，不会拿训练命令代替描述。

### 同机多卡

```sh local
gpuctl run -g 4 --min-vram 24 -- python -m torch.distributed.run --standalone --nproc-per-node=4 train.py --output /outputs
```

程序本身须支持多卡。平台只在已选服务器分配卡，不改写单卡程序、不把显存合并成一张大卡，也不自动跨服务器训练。

### 弹性卡数与自动扩卡

```sh local
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 -- python train.py
```

`-g` 是最大卡数，`--min-cards` 是最少启动卡数；按当前最多的合法空卡启动。合法条件是 global batch 能被「实际卡数 × 每卡 micro batch」整除，梯度累积次数也必须是整数。例中合法卡数为 1、2、4、8；空闲 3 张时启动 2 张。普通成员的个人额度仍按最大卡数占用；管理员免个人累计额度，但最大卡数也不能超过单机物理容量。

自动扩卡还需要保存让位和恢复：

```sh local
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 --auto-expand --rank P1 --yield save --checkpointable --restart-policy on-preempt -- python train.py
```

新空卡出现后先保存、结束旧训练尝试，再从 checkpoint 以更大合法卡数启动，不是热挂显卡。程序要按 `GPUQ_WORLD_SIZE` 的实际卡数启动 DDP，用 `gpuq.elastic.plan_elastic_batch()` 计算累积；不能把 worker 数固定成最大卡数。固定 global batch 时 LR 不自动改变；平台不替代码实现梯度累积、保存或恢复。排队任务优先于扩卡，保存失败不强杀。

### 固定显卡与轻任务共享

先在算力总览观察空位和显存，再选物理卡号：

```sh local
gpuctl run --gpu 0,2 -- python train.py
gpuctl run --gpu 3 --share --vram-mib 4096 -- python small.py
```

固定选卡绑定物理 UUID；共享是新任务自己选择同卡运行，可与外部或普通托管任务共存，仅需新提交者同意。普通成员的共享任务占 1 张额度；管理员的共享和独占任务均免个人累计用卡额度，但仍须满足节点显存预算、能力与调度检查。共享不支持弹性、自动让位、自动恢复或主动抢占；不启用 HAMi 的共享预算只是提交前估算，没有硬显存隔离，可能互相影响或 OOM。

长训练先选择下面一种方式，不能把共享和自动恢复同时打开：

- 整卡任务：不与其他平台任务共享分配；程序适配后，可由平台保存让位、自动恢复。
- 普通共享：允许同卡运行；程序可以自行周期保存，但平台不自动让位或恢复。
- HAMi 共享：在节点验收的范围内增加显存限制；同样不支持平台自动让位或恢复。

需要共享跑长训练时，使用 `--yield never --restart-policy never`，可以保留 `--checkpointable`，并由程序定期把完整检查点写到 `/outputs`。这不代表平台会自动恢复；中断后要用自己的恢复参数重新提交。确实需要平台保存让位和自动恢复时，改用整卡任务并接入 checkpoint 适配器。提高排队等级或启用 HAMi 不会解除这一兼容限制。

节点确实支持 HAMi 时可用：

```sh local
gpuctl run --gpu 3 --share --vram-mib 4096 --hami -- python small.py
```

`--hami` 的显存限制与 `--sm-percent` 的算力比例限制是两项不同能力。只有节点确认支持并验收算力限流后，才能额外使用例如 `--sm-percent 50`；缺少能力时平台会拒绝，不能仅根据已安装 HAMi 就假定两项都可用。

HAMi 只限制这项任务，不限制同卡外部进程，也不保证性能比例；SM 限额需节点额外支持。能力或库缺失会拒绝，不会静默降级。网页有对应的弹性、固定和共享选项。

### 停止一项训练

! 取消不会保存，也不会自动恢复。

```sh local
gpuctl cancel JOB_ID
```

确认进程已停止、扩卡占用已清理后才释放额度；`UNKNOWN` 不等于已停止。取消不是保存 checkpoint，不自动恢复，也不删除已写出的结果。`watch` 中按 Ctrl+C 只退出查看，不会取消任务。

## 数据集 {#data}

数据集只登记训练、验证、测试样本；个人预训练权重、tokenizer 和模型配置按[项目开发](/guide/development)放在项目内，不登记为数据集。

网页只有一个“数据集”入口。上方查看版本和就绪位置；电脑上的数据通过校内直传上传，服务器上已有的文件在个人数据空间整理。相同数据集 ID 和完整版本才合并显示，同名不代表内容相同。

所有已登录成员都能浏览仓库目录，包括尚未分配机器的账号。标为“仅浏览”的数据可以查看所属用户、大小、版本和位置，但不能读取文件、准备或用于训练；使用前需取得数据和机器授权。公开目录不开放任何人的个人工作区、权重或结果。

“数据在哪里”按版本展示各机器的副本位置；“本次使用”是接下来训练的机器。已就绪、没有此版本、目录未确认是三种不同结果，其他机器已就绪不代表本人有读取权限或本机可以直接训练。添加数据在侧栏里完成，切换方式或关闭侧栏保留填写的内容；切换账号会清空旧账号内容。

目录显示授权记录对应的用户名：单人显示“所属用户”，多人显示“共享授权用户”，不把授权用户当成创建者。账号已删除或旧节点未完整提供归属时明确显示未知；同版本在不同机器上的授权不一致时显示“各机授权不同”，各副本分别标注。此说明不改变数据集 ID、版本或读取权限，也不会根据名称前缀猜归属。

给自己常用的数据起一个易读名称：

```sh local
gpuctl data label DATASET_ID --display-name "ZJU 人体训练集"
```

这是自己的显示名，支持中文；不改真实 ID、版本、文件或其他共享用户的名字。训练的 `--data` 仍使用原 `DATASET_ID@VERSION`。去掉 `--display-name` 可查看当前名称；另一处同时修改时会提示冲突，不覆盖对方刚保存的内容。

### 校内直传（支持续传）

普通成员可以上传个人数据，不需管理员逐份代传。先连接能访问上传节点的校园网络，再用 `gpuctl use MACHINE_ID` 选择已获授权的机器：

```sh local
gpuctl data upload ./my-data --name my-data --via direct
gpuctl data upload-status UPLOAD_ID
```

保持同一目录、机器和名称，重复原上传命令可续传；期间不要修改目录。显示 `READY` 后复制返回的完整数据集 ID、64 位版本和训练路径，ID 可能与输入短名不同。

`--via direct` 只允许直传：文件直接到服务器，不经过 VPS 文件中转；不需要额外的 Tailscale 账号或服务器密码。客户端会显示实际传输路径；如果不是校内直传，停止并联系管理员核对。直传断开不会偷偷改走中转，重新执行原命令即可核对并续传。

节点入口不可达时上传会停止。先确认校园网络、所选机器和入口状态；仍失败就把机器 ID、上传编号和报错交给管理员，不要改用中转或反复新建上传。

网页选择目录后，先确认路线显示「直传到」所选服务器，路径中没有门户中转或备用入口。如果页面只提供中转或无法确认路线，先停止，使用上面的 `--via direct` 命令。关闭网页会停止电脑侧传输；已经开始的服务器校验会继续。

仅当想放弃未完成上传时执行下面命令；不要跟着正常上传步骤一起运行，不删除就绪版本：

```sh local
gpuctl data upload-discard UPLOAD_ID
```

### 整理服务器上已有的文件

电脑上的数据优先整理成目录后按上面的校内直传上传。下面用于已经放在本人数据空间的文件，例如管理员协助从外接硬盘导入的压缩包；不是另一条电脑上传通道。

网页「数据集 → 添加数据 → 个人数据空间」中的个人数据终端，`/data2` 只对应**你在当前服务器上的可写目录**，不是整块数据盘；其他用户的数据、已发布版本和 GPU 不可见。CLI 在自己电脑执行：

```sh local
gpuctl data shell
```

确认 `samples.zip` 已在个人数据目录中，再进入数据终端整理：

```sh data
mkdir -p samples
unzip samples.zip -d samples
exit
```

压缩包不会自动解压；先检查来源、解压大小和空间。数据终端没有 GPU；`gpuctl data files` 查看目录，`gpuctl data shell --reconnect SESSION_ID` 重连。连续无输入 1 小时或累计 6 小时会结束，不适合用作长期后台任务。

结束这台机器上自己的所有数据终端，回到自己电脑发布：

```sh local
gpuctl data publish samples --name samples
gpuctl data workspace-status OPERATION_ID
```

发布期间不能修改数据目录；只断开终端不够。显示 `READY` 后用返回的引用训练。发布保留可写目录并生成独立只读副本，需要两份空间；之后修改草稿不影响已发布数据。未启用内核配额的节点，手工写入尚无独立磁盘硬配额；大规模解压先核对空间。开通节点的个人 byte/inode 上限由管理员配置，超限会拒绝写入，不自动扩大容量。

### 使用数据训练

数据集页显示各机器上的版本和就绪位置。选择本次训练机器：本人有权使用且本机已就绪的版本可以直接使用；有授权来源时点「准备到本机」，或「准备后训练」。管理员启用节点间私网传输后，平台可将其他已授权机器上的固定 READY 版本复制过来，文件字节不经过 VPS。仅看到其他机器有数据，不保证通道已启用或当前能复制，也不代表获得读取授权；状态未知时不会申请 GPU。

容量栏是服务器共享数据盘的剩余空间，不是个人硬磁盘配额。即使节点另行开通个人配额，也不要把这个数当作自己的额度。某台机器查询失败会显示部分结果，不代表那里没有数据。

### 可选的长期保存与本地缓存

管理员启用并验收 0.4.3 的自动归档后，**之后新上传或发布的个人版本**会在后台保存到指定 HDD 原件，再认证本地训练缓存。上传到哪台机器、在哪台机器训练仍由你选择，不会默默换机；读取自己的归档也不需要 HDD 机器的 GPU 额度。旧数据默认受保护，不会自动搬迁或补归档。页面没有长期保存状态时，不要假设已启用。

旧版本从未归档时，请将数据集 ID、完整版本号和所在机器交给管理员首次纳管，不要反复点“重试”。只有既有机械盘原件核验成功后，本机副本才可作为缓存回收；核验前仍保留原数据。

本机 `READY` 和长期保存完成是两件事：归档未完成或失败时保留本机原件。完成后也不立即删除本地缓存，只在管理员另行启用回收且空间达到水位时回收没有任务读取、没有固定保留的已认证副本；以后准备会从固定原件重新校验取回。HDD 单份原件不是备份，训练结果、模型和 checkpoint 仍需自行另存。

长期保存失败时先排查提示，再在数据集页重试，或使用：

```sh local
gpuctl data archive-retry DATASET_ID@VERSION --machine MACHINE_ID --json
```

不要对后台归档直接运行 `transfer resume`。未知状态会继续保留保护，已永久取消需管理员核查，不会换编号绕过取消。

### 准备与提交训练

```sh local
gpuctl data list
gpuctl data prepare DATASET_ID@VERSION
gpuctl data status DATASET_ID@VERSION
```

确认所选机器的项目显示 `READY`，数据已就绪或目录明确有可用来源后，运行：

```sh local
gpuctl run -g 1 --data DATASET_ID@VERSION -- python train.py --data /data2/DATASET_ID --output /outputs
```

自己的上传已在本机 `READY` 时不必重复准备；「已登记」「准备中」或「未知」不等于就绪。准备中先等待，不占显卡；失败时先在数据集页或 `data prepare` 明确重试，不能靠反复提交训练无限重试。`--` 前的 `--data` 是平台挂载声明，后面的参数由自己的程序处理，路径以平台返回值为准。训练数据只读，缓存和预处理输出写 `/outputs`。

配套新版会保护准备完成的数据，并在训练期间继续保护；任务未确认停止或状态未知时不会释放保护。取消准备不等于强停已经开始的训练。

数百 GB／TB 本机数据使用校内直传，或联系管理员协助外接硬盘导入。单份清单最多 500,000 条且不超过 64 MiB，空间还受节点和账号限制；平台副本不是备份。项目代码、权重和训练结果按各自章节操作，不要把它们登记成数据集，也不要把数据集直传当作所有文件操作的传输路线。

### 持续传输（需传输任务新版）

这部分是管理员启用后的可选能力，不会因更新客户端自动开放：门户、节点和客户端都需支持，LAN copy 还需管理员配置并核验节点间接口。没有「传输任务」入口时，上传使用上面的校内直传；不要把指南更新当作功能已经上线。下面的 VERSION 用完整 64 位版本替换。

```sh local
gpuctl transfer upload ./my-data --name my-data --via direct
gpuctl transfer download DATASET_ID@VERSION ./new-download
gpuctl transfer list
```

上传仍使用校内直传；入口不可达时停止，不改走中转。上传和下载重复同一命令可续传，但电脑离线不能继续提供或接收文件。下载到新目录，不覆盖已有目录；全量 SHA256 通过才完成。网页「数据集」上传进入传输列表。

项目文件／训练结果用 `pull`；没有整份已发布数据集的一键下载入口时，需管理员启用上述目录下载。不要把 `pull --job` 当作数据集下载。

配套新版下载在整次读取期间保留读取保护，断线不会自动过期；完成或明确取消才收尾。旧 `sync data` 没有整次读取保护，对开启 GC 的 cache 版本会明确拒绝，应改用新版 `transfer download` 或从受保护原件读取，不会自动换源。

```sh local
gpuctl transfer copy DATASET_ID@VERSION --from SOURCE --to TARGET --name my-data --detach
gpuctl transfer status TRANSFER_UUID
gpuctl transfer watch TRANSFER_UUID
```

服务器间 copy 在 LAN 后台执行，不占 GPU，关电脑仍继续；只复制固定数据集版本，不迁移训练或环境。`WAITING_CLIENT` 等待本机，`VERIFYING` 校验，`UNKNOWN` 未确认，不会自动换机或重跑。复制请求丢失时用打印的原 `--key` 重试；只在确认停止为 FAILED / PAUSED 时用 `gpuctl transfer resume TRANSFER_UUID` 恢复原任务。

数据页中的“传输任务”按“需要处理”“进行中”“已完成”分组；“已加载”是当前页记录，不是所有任务总数。若还有下一页，继续加载后再核对完整记录。停止传输保留未完成文件，不会自动重跑。

“需要处理”保留未确认的传输和近期失败。已查看或超过一天的明确失败可从提醒中收起，原记录和错误仍保留；`UNKNOWN`、部分完成或回执未确认不会因为过了一天就当作已解决。提醒数量不是当前占用的 GPU 数。

```sh local
# 仅在确定放弃这一项传输时执行，终止后不可恢复；保留断点供检查
gpuctl transfer cancel TRANSFER_UUID
```

训练通过 `run` 已经持续运行，不靠 tmux；网页交互终端仍有时限。传输任务负责版本的上传、下载和节点间复制，不是任意长 CPU 脚本执行入口。旧 push、单文件 pull、sync git/code 保持原行为。

## 日志与结果 {#results}

### 队列、进度和错误

```sh local
gpuctl jobs
gpuctl watch JOB_ID
gpuctl logs JOB_ID
gpuctl diagnostics JOB_ID --json
```

`watch` 默认每 5 秒核对，`--interval 1` 可调整；Ctrl+C 只停止查看。完成、失败、取消或状态未知时反馈并退出，断开连接后可再次 `watch`；不会取消、恢复或重试训练。

若曾由管理员在节点上用原生 `gpu retry` 重试同一任务，门户历史终态不会被自动改写。`watch` 与 `diagnostics` 可另外返回该节点的只读观察及已确认重试事件；缺少身份或事件证据时显示未确认。`watch` 会明确区分“门户历史结果”和“节点只读观察”，退出码仍按原门户终态，不代表新一次运行已结束；此查询不会清除取消标记、重新申请数据保护或批准重试。需要恢复执行时请管理员核对原 UUID 的当前状态与保护边界，不要反复重试或另建任务绕过。

若原生重试已经成功，但后续任务仍被门户旧 FAILED 记录挡住，用 `gpuctl completion JOB_ID --json` 核验同一任务的最新完成状态。只有返回 `completed:true` 且任务 ID、项目、发布版本符合预期才可作为完成依据；旧失败历史保留，不需要重复训练。该命令成功核实退出 0、未确认退出 2、请求错误退出 1，不替代结果质量检查。

如果最新尝试已成功，但数据资源尚未收尾，可显式运行 `gpuctl reconcile-resources JOB_ID --json`，再用 `completion` 核验。它只在节点确认该次尝试及全部相关进程已停止后释放数据租约，不重跑、不取消训练，也不改写旧失败历史；运行中或身份变化时会拒绝，不要手工删除租约或收据。

网页任务表可显示轮次、步数和训练上报 ETA。准确进度需要程序接入 `gpuq.progress.ProgressReporter`；未适配显示「进度未上报」，仍可看日志。训练上报 100% 或异常，不代表平台已确认任务结束。`RUNNING` 不保证每个 worker 都健康；先看最近 200 行主日志，再看 worker 诊断、退出原因和历史分配。

任务详情和 CLI 区分「节点运行结束」与「门户确认终态」：前者来自最近一次调度运行记录，后者可能因离线或稍后对账而延迟。原始 JSON 的 `workerFinishedAt` 与 `terminalObservedAt` 分别对应两者；旧字段 `finishedAt` 保留门户确认时间的兼容含义，不应用来计算实际训练时长。节点结束证据缺失时显示未确认；不因诊断包不完整就编造退出原因，也不改写原任务历史。

任务信息新版还可查询同机成员的公开姓名、任务名和描述：

```sh local
gpuctl queue
gpuctl queue --machine MACHINE_ID
```

旧门户先用 `state/jobs`；没有平台记录或进程归属证明时，不猜外部任务的姓名。其他人的命令、日志、结果和操作权限不会开放，采集过期也不能当作空闲。

在服务器 SSH 终端用 `gpu q` 查看原生队列。需门户、节点桥和 GPUQ 显示协议都升级后，才显示门户提交的真实姓名与任务名；仍显示 `portal-*` 就请管理员核对配套版本。已有排队／运行任务会按原提交键自动补齐显示，不重提交或重启训练；本机直接提交的原生任务仍使用自己的 name/owner。

### Telegram 通知（可选）

先请管理员为你的账号配置 Telegram 收件人，再订阅自己的未结束任务：

```sh local
gpuctl notify JOB_ID on
gpuctl notify JOB_ID status
```

网页任务表也有开关，默认关闭。可接收完成、失败、训练上报警告／异常和停滞反馈；`status` 看待发与失败数量。通知失败不改变训练状态，通知可能延迟或重复，实际结果以平台为准。

只在想关闭通知时执行 `gpuctl notify JOB_ID off`，不是订阅后的必做步骤。

### 下载结果

```sh local
gpuctl files --job JOB_ID
gpuctl pull --job JOB_ID model.pt ./model.pt
```

保持任务原服务器和项目；不同项目或机器的输出不会自动搬运。已有同名本地文件换个名称，避免覆盖。网页能浏览和下载，超过 100 MiB 的单文件用 CLI；这些操作不会自动备份。管理员另行配置的节点备份只覆盖明确列入的目录，不代表所有机器和个人结果都有备份；重要产物应确认备份范围与恢复验收。

### 给任务留言

```sh local
gpuctl notes
gpuctl note --job JOB_ID "预计今晚结束"
gpuctl note --general "本周维护安排"
```

网页打开「协作区 → 聊天」，展开聊天里的“任务留言”，有相同入口。任务留言只能关联自己的未结束平台任务，平台确认完成、失败或取消后自动清理正文；排队、让位中、状态未知时保留。非任务留言保留到手动删除。作者可用 `gpuctl note-delete NOTE_ID` 删除自己的留言，管理员可删除他人留言。留言对登录成员可见，每条最多 2000 字符；普通聊天消息不跟随训练结束自动清理。

## 排队与协作 {#queue}

### 等级、被抢占和恢复分别设置

网页展开「提交训练 → 自定义 GPUQ 调度」。P0–P4 越大越优先，普通成员可提交 P0–P2，P3/P4 由管理员使用。低等级不等于同意被中断：

```sh local
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

```sh local
gpuctl run --rank P2 --mode preempt1 -g 1 -- python urgent.py
gpuctl run --rank P2 --mode preempt2 -g 1 -- python urgent.py
```

模式 1 只选择明确愿意让位且能保存的低等级任务；模式 2 对 `now` 任务立即让位，对 `save` 任务仍先保存，不越过对方约定。默认 `queue` 也按被抢占任务自己的 now/save 约定调度，不代表占满后永远不能抢占；默认模式、请求模式与自己的被抢占方式是不同选项。

同等级不互抢，`never`、旧 `legacy`、共享和外部进程不被这些新模式强杀。请求的卡数、普通成员个人额度和节点能力仍要满足，缺能力会拒绝，不会自动换机或降级。管理员的额度豁免不会改变上述让位规则。旧 `--priority idle|normal|high` 仍兼容，但不能与上述自定义选项混用；其中 `idle` 允许结束任务，不自动保存或重跑。

管理员可修改已核验待启动任务的排队等级：`gpuctl priority JOB_ID P1`。只改排序，不改让位和恢复，不作用于已运行任务。

### 额度和团队交流

普通成员的排队、启动、运行和状态待确认任务都会计入额度；弹性任务按最大卡数占用。每台机器的卡数上限与所有机器合计上限同时生效；合计上限不会自动替你挑机器。额度不保证立即有空卡，有额度也可能等卡。不要用瞬时 0% 利用率判断显卡空闲。

管理员可访问全部机器；共享和独占任务均免个人累计用卡额度，无需执行 `grant --full`，也不受升为管理员前保存的个人额度限制。单个任务仍不能超过所选机器的物理卡数，不豁免实际显存、节点授权和调度约束。资源不足时正常排队，不会因为管理员身份抢停其他训练；已有显式让位模式仍按其独立规则执行。手选、自动选机、准备完成和首次派发采用同一额度规则；每人最多 10 个准备中任务、全平台 5000 条任务历史的保护仍然有效。

准备项目或数据时尚不占 GPU 额度；准备完成和首次派发前会重新检查当前角色与授权。降为普通成员后，新提交及尚未派发的任务重新受个人额度约束；不会仅因降级停止已经派发或运行中的训练，结果未知的任务也不会假装释放。成员原有额度保留，不会被管理员的全部机器视图覆盖。

协作区只有“帖子”和“聊天”两个入口；桌面并排显示，手机用标签切换。帖子用于公告和问题反馈，聊天用于即时交流；留言不会自动改变配额、队列或取消任务。反馈问题注明机器、任务 ID、时间和复现步骤，不要粘贴密码、令牌、私钥或私密训练数据。

## 常见问题 {#troubleshooting}

### 页面提示维护中

维护横幅会显示全平台或指定机器的原因。维护期间暂停新训练、个人终端新建/重连与输入、文件上传/写入、发布、数据准备、传输启动/续传和自动归档推进；仍可看历史、日志、状态，取消任务/传输，以及关闭或断开终端。已有上传与停止尚未确认的保护不会被自动删除。网页与 CLI 使用同一维护限制。

维护状态重启后仍保留，只有管理员明确恢复才解除。开启维护**不会自动结束已有任务、终端或节点后台服务**，也不等于服务器已停止；实际诊断维修由管理员另行安排。解除后，未取消的准备/等待任务可继续；已取消或其他已结束的任务不会自动重跑。已运行的训练通过原调度系统停止后，仍须等待平台确认停止。管理员独立 ROOT 运维入口保留，个人开发入口不豁免。

`gpuctl maintenance status` 可查看当前状态。管理员先读取其中的版本号，再执行 `gpuctl maintenance on all --reason "存储诊断维修" --revision N`；完成后先再次读取版本号，再用 `gpuctl maintenance off all --revision N` 明确恢复。`N` 是刚读取的数字，不是固定值；`all` 可替换成具体机器 ID。解除全平台维护不会解除另外设置的单机维护。旧的维护申请/审批流程仍停用。

### 同步代码或数据到另一台机器

来源、目标和版本由自己选择，先预览：

```sh local
gpuctl sync git ./my-repo --ref HEAD --to TARGET --project new-project --dry-run
gpuctl sync code --from SOURCE --to TARGET --project my-project --release FULL_HASH --target-project new-project --dry-run
gpuctl sync data DATASET_ID@VERSION --from SOURCE --to TARGET --name my-data --dry-run
```

将 `SOURCE/TARGET` 换成获授权机器 ID，去掉 `--dry-run` 才传输。Git 仓库须干净并支持 `check-attr --source`，只导出固定提交；已有节点代码只复制固定 release。目标须是新项目，重复同一命令可续传，不覆盖旧项目、不删除目标其他内容。

代码显示 `CODE_READY` 还不能训练：在目标 `use`、`project use`、`ssh` 准备依赖，退出后 `project publish/status`，等 `READY`，使用目标的完整 `--release`。同步不迁移 Conda/venv、草稿或结果。数据使用返回的目标完整 `名称@版本`，内容版本必须一致；这不是自动多机调度，也不是 TB 级高速直传。

### 发布或模型加载失败

发布前结束所有项目开发终端，不能只断开；检查错误提示中属于自己的文件和链接。不要给系统目录批量改权限。训练和开发终端的 HOME 不同，默认缓存不会自动带进训练；个人预训练权重、tokenizer 和模型配置按[项目开发](/guide/development)放在项目内并发布，无需每次重新上传。

项目网络检查与一次性代理：

```sh project
gpuq-network show
gpuq-network check https://pypi.org/simple/
gpuq-network exec --proxy http://PROXY_HOST:PORT -- python -m pip install -r requirements.txt
```

这些命令在项目开发终端执行。代理地址由管理员提供，不直接照抄宿主机 `127.0.0.1`，不要把含密码代理写进项目或反馈。

### 提交超时、任务 UNKNOWN 或无法取消

先查 `jobs/watch`、日志和诊断。`UNKNOWN` 不表示已结束，额度仍保留；不要重复建任务或删目录。提交重试用原输出的 `Submission key`，加原 `--key UUID`、同一个完整 `--release` 和原参数，不能换策略重试。仍无法确认就把任务 ID 交给管理员。

### 缺少系统依赖

项目终端可以安装个人 Python 包、编译自己的依赖。节点开通个人容器环境后，新项目可选择「个人容器」，在容器内安装系统包；这不会修改服务器。现有共享/隔离 Python 环境继续可用，但不能通过 `sudo apt` 修改宿主机。若节点尚未开通个人容器，请在“协作区 → 帖子”说明缺失依赖和错误，让管理员评估安装。容器镜像、可写层、代码、数据和输出都会占用存储空间；只有管理员另行启用并验收内核配额的节点，才具有个人磁盘硬上限。容器已开通不等于硬配额已开通。

旧维护申请流程已停用，不能提交脚本申请 root，也不需要为普通开发和训练申请审批；已有申请只保留历史查看。原有系统账号、原生 SSH、Tailscale 是独立入口，平台注册不授予这些权限。

### 登录过期或换账号

登录会话保存在门户数据库；保留原数据库时，重启／更新门户不需要重新登录。默认 30 天未使用才过期，正常使用自动续期；浏览器凭据缓存一年，CLI 缓存保留到主动退出，不保存明文密码。

首次从旧版升级需重新登录一次，旧内存会话无法恢复。主动退出只撤销当前登录；管理员改密码、停用账号或改角色会撤销该账号所有登录。浏览器清理 Cookie、凭据缓存满一年，或更换平台地址，也需要重新登录。

确实过期时用 `gpuctl login`，主动退出用 `gpuctl logout`；换账号后重新选服务器和项目。登录失效不会停止已经提交的训练。


### 删除数据版本

你只能删除有个人来源证明的本人上传、工作区发布或副本；旧数据、共享数据和管理员登记请联系管理员。新节点尚未开通删除能力时，彻底删除暂不可用。

从一台服务器删除可重新准备的缓存：`gpuctl data unregister NAME@完整版本 --machine SERVER`。新版节点拒绝直接清除最后一份数据；数据库原件、正在训练或有固定保留的数据也不能用这个入口。节点未更新时仅管理员保留原按机器删除入口，门户先确认另有完整副本；无法确认时拒绝删除。

网页在数据集详情中提供「彻底删除」，需要输入数据集名称确认。节点开启能力且证明这是你可删除的版本时才显示入口；删除结果未确认时，只用原编号重新查询。页面按步骤显示结果，删除完成后列出可恢复至的时间。继续、取消和恢复需要管理员处理。

彻底删除全部服务器和数据库里的这一版本：`gpuctl data delete NAME@完整版本 --key UUID`。先保留输出的 key，用 `gpuctl data delete-status UUID` 查询；超时或“结果未确认”不要换编号重投。其他名称下的独立副本不受影响。完整副本隔离保留至少 7 天，仍占空间；期限内只有管理员可恢复，到期且收集服务已开启并确认隔离和时钟后才会清除。恢复命令是 `gpuctl data retire-restore OPERATION_ID --machine SERVER`，旧授权不会恢复。管理员也可用原任务编号显式 `retire-continue` 或 `retire-cancel`；继续只在原进程确定停止后重试原失败阶段；取消只还原数据，不继续删除、不杀训练。恢复原源时会同时处理这一任务的全部副本。实际清除后可以重新上传同名数据；管理员确认新的原源 READY 后，可用原恢复命令释放其余位置，旧授权不会复活。

新登记在安装前失败且不再重试时，管理员可用 `gpuctl data retire-discard-registration OPERATION_ID --machine SERVER --key UUID` 撤回这份准备意图；物理别名另加 `--name NAME`。它不删除数据，不解除删除墓碑，已经安装的登记不能撤回。保留 key，回执不明只沿用相同命令和 key 核对；登记意图分代保存，后续可以再次删除、清除并重新上传。
