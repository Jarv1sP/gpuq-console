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

进入项目终端后执行：

```sh project
python -m pip install -r requirements.txt
python -m pip check
exit
```

代码在 `/workspace`，私人环境在 `/opt/project-env`。默认继承基础 Python 包；需要空环境时新建 `gpuctl project create clean-project --env-mode isolated`。项目名以小写字母开头，可含数字、下划线和连字符，最长 48 字符。

需要 apt 等系统包时，可在管理员已启用的节点新建 `gpuctl project create system-project --env-mode oci`。这是个人 rootless 容器：容器内 root 不是宿主机 root，开发阶段无 GPU；安装依赖后退出终端再发布，训练固定该镜像版本并只见调度分配的 GPU。未启用节点明确拒绝，不改变原有项目。未显示该能力时，按[常见问题](/guide/troubleshooting)联系管理员，不将本指南视为已经开通。

管理员开通磁盘硬配额后，可用 `gpuctl project quota --machine MACHINE_ID` 查看本人实际 byte/inode 用量、上限和剩余。这里的 inode 是文件和目录的计数，不是用卡额度。显示“未启用”或查询失败不代表零用量或无限容量；数据目录与工作区在同一个物理卷时共用该卷的个人硬上限。

项目终端的 `$HOME` 是可写的 `/home/gpuq`，其缓存与私人环境使用平台工作区磁盘。shared/isolated Python 模式的 `/tmp` 是计入内存限制的临时文件系统，不是额外磁盘容量；开通的 OCI 模式默认 `/tmp` 在个人配额内的容器可写层。大包构建可在项目终端把临时文件放到私人 HOME，安装完成后自行清理不再需要的临时文件：

```sh project
mkdir -p "$HOME/.cache/build-tmp"
TMPDIR="$HOME/.cache/build-tmp" python -m pip install -r requirements.txt
```

继续已有项目用 `gpuctl project use my-project`；查看项目用 `gpuctl project list`。`push .` 跳过常见环境和秘密文件，但不能识别所有敏感内容，上传前自己检查；不会删除服务器多出来的旧文件，也不会登记或发布数据集、替你迁移本机环境。它不会自动排除数据目录，不要把数据集混进代码目录。

个人的小体积模型权重直接放在项目 `/workspace/weights`，随项目发布为版本，训练从该路径读取即可，不需要单独管理。已经在服务器项目中的权重不用每次从电脑重新上传；发布可能在服务器内部复制快照，这与电脑上传不同。新训练产生的 checkpoint 仍写每个任务独立的 `/outputs`，不要覆盖输入权重。

### 终端断开与重连

每次 `gpuctl ssh` 都会**新建独立终端**。它走 HTTPS，不是原生 SSH，不能直接填入 VS Code Remote-SSH、SFTP 或 rsync。

- `exit` 或网页「结束终端」：结束会话；`exit` 结束的终端不能重连。
- `Ctrl+]` 或网页「断开」：只断开连接，会话继续运行。
- 重连原会话：使用原服务器、项目及会话 ID；另一客户端仍在操作时，明确协调后才用 `--takeover`。

```sh local
gpuctl ssh --reconnect SESSION_ID
```

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

### 退出项目终端后同步运行

先选好服务器和个人项目，准备服务器环境，并退出该项目的开发终端。再在电脑代码目录运行同步，合并上传、发布和等待。

```sh local
gpuctl run --sync -g 1 -- python train.py --output /outputs
```

也可以明确指定本地目录；Windows PowerShell 和命令提示符均用双引号包住含空格的路径，无需 Bash、rsync 或 WSL：

```powershell local
gpuctl run --sync --sync-dir "C:\研究代码\我的项目" --project my-project -g 1 -- python train.py --output /outputs
```

`--sync` 复用 `push` 的分块上传与 SHA256 校验，然后按本次发布的 UUID 等待 READY 回执，并核对不可变版本清单中的已上传文件；只提交这个版本，不回退到以前的 READY。上传失败、本地文件中途变化、发布失败／状态未知、并发发布替换、校验不一致或等待超时（最多两小时）都会停止，**不提交训练**。它不会替你结束终端、安装依赖、变更权限或切换机器；旧节点尚不支持发布确认时，在上传前明确拒绝。

这是现有代码上传流程的快捷入口，**不是增量镜像或删除同步**：本次目录内的文件会重传，与 `push` 相同的秘密／环境目录会跳过，远端多余文件保留；空目录或全部被排除时不会发布旧草稿。不要把数据集混在代码目录中。服务器已有的小体积 `weights/` 可以保留，不必为本命令重新搬回电脑；发布可能在服务器内部复制代码和环境。`--sync` 不能与 `--release`、`--legacy` 或管理员宿主模式合用。

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

`-g` 是最大卡数，`--min-cards` 是最少启动卡数；按当前最多的合法空卡启动。合法条件是 global batch 能被「实际卡数 × 每卡 micro batch」整除，梯度累积次数也必须是整数。例中合法卡数为 1、2、4、8；空闲 3 张时启动 2 张。个人额度仍按最大卡数占用。

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

固定选卡绑定物理 UUID；共享是新任务自己选择同卡运行，可与外部或普通托管任务共存，仅需新提交者同意。共享占 1 张额度，不支持弹性、自动让位、自动恢复或主动抢占；普通共享预算是提交前的估算，没有硬显存隔离，可能互相影响或 OOM。

节点确实支持 HAMi 时可用：

```sh local
gpuctl run --gpu 3 --share --vram-mib 4096 --hami --sm-percent 50 -- python small.py
```

HAMi 只限制这项任务，不限制同卡外部进程，也不保证性能比例；SM 限额需节点额外支持。能力或库缺失会拒绝，不会静默降级。网页有对应的弹性、固定和共享选项。

### 停止一项训练

! 取消不会保存，也不会自动恢复。

```sh local
gpuctl cancel JOB_ID
```

确认进程已停止、扩卡占用已清理后才释放额度；`UNKNOWN` 不等于已停止。取消不是保存 checkpoint，不自动恢复，也不删除已写出的结果。`watch` 中按 Ctrl+C 只退出查看，不会取消任务。

## 数据集 {#data}

网页只有一个“数据集”入口。上方查看版本和就绪位置，需要新数据时展开“添加数据”，选择目录上传、链接导入或文件整理。相同数据集 ID 和完整版本才合并显示，同名不代表内容相同。

“数据在哪里”按版本展示已授权机器的副本位置；“本次使用”是接下来训练的机器。已就绪、没有此版本、目录未确认是三种不同结果，其他机器已就绪不代表本机可以直接训练。添加数据在侧栏里完成，切换方式或关闭侧栏保留填写的内容；切换账号会清空旧账号内容。

目录显示授权记录对应的用户名：单人显示“所属用户”，多人显示“共享授权用户”，不把授权用户当成创建者。账号已删除或旧节点未完整提供归属时明确显示未知；同版本在不同机器上的授权不一致时显示“各机授权不同”，各副本分别标注。此说明不改变数据集 ID、版本或读取权限，也不会根据名称前缀猜归属。

### 保存与取回云端副本

“云端副本”可以把个人 `/data2` 中已经整理好的压缩包保存到平台云盘。选择已开通的存储节点，填写文件相对路径；显示“待云端确认”时点击“检查云端”，确认后可以取回到新的路径。后台继续传输，关闭页面不影响已开始的任务。

已确认的文件也可点击“重新校验”。若下载提示“文件已变化”，先重新校验对应的云端副本，再取回到新的路径；旧下载不会自动续传，已有文件和临时内容都会保留。普通连接中断仍按原下载的编号续传，不要因此另建上传。

```sh local
gpuctl data cloud upload incoming/data.tar
gpuctl data cloud list
gpuctl data cloud verify FILE_ID
gpuctl data cloud download FILE_ID restored/data.tar
```

成员共用平台的传输服务，但各自只能查看自己的文件，不需要管理员的网盘账号。云端确认前保留原件；这一入口操作服务器上的文件，电脑上传仍使用下方的上传通道。

### 从云盘或下载链接导入

数据已经在网上时，打开“数据集 → 添加数据 → 下载链接”，选择服务器，粘贴阿里云盘分享链接或 HTTPS 文件直链，选好文件和个人目录内的保存路径，再开始导入。已开始的导入在服务器后台运行，关闭页面或自己的电脑不会中止。

阿里云盘是可选功能：需管理员启用可用的下载通道，并完成后台授权和真实下载验收；成员不需要登录管理员的网盘。未启用或连接不可用时，先使用 HTTPS 直链，不要把手册命令当作已经开通。成员不能浏览管理员的云盘或取得账号令牌；只导入自己有权使用的数据。当前支持分享根目录的文件，不递归导入文件夹，大目录建议先打包。

```sh local
gpuctl data import 'https://example.org/dataset.zip' incoming/dataset.zip
gpuctl data imports
gpuctl data import-status IMPORT_ID
```

阿里云盘开通后可用 `gpuctl data import '阿里云盘分享链接'`；有提取码加 `--password-code`，多文件分享按提示选 `--file-id`。开始前结束自己在目标机器上的所有数据终端；导入期间个人数据目录锁定，不影响项目终端或训练。

文件由训练服务器直接下载到个人数据目录；VPS 只传递授权、链接和进度信息，不搬运文件内容。源站仍可能限速或限制下载。中断后先查看状态，只有确认源文件未变化时才续传：

```sh local
gpuctl data import-resume IMPORT_ID
```

阿里云盘链接过期时会重新解析；HTTPS 链接过期可附加 `--source-url '新的HTTPS直链'`，必须仍是同一文件。只想停止下载时才执行：

```sh local
gpuctl data import-cancel IMPORT_ID
```

取消会停止下载，但保留临时数据。确认停止后，确实不要这一份临时内容才执行 `gpuctl data import-discard IMPORT_ID`；不会删除已完成文件。完成后自行检查文件、解压并发布，平台不会自动解压、执行文件、发布或复制到其他机器。

### 直接在个人目录下载

需要源站专用工具时，也可以进入 `gpuctl data shell`，用节点已有的下载工具保存到个人 `/data2`；源站授权由自己提供。数据终端连续无输入 1 小时或累计 6 小时会结束，大文件优先使用上面的后台链接导入。

下载回自己电脑是另一条路径：项目文件／训练结果可以 `pull`，旧后台没有整份已发布数据集的一键下载入口；管理员启用传输任务新版后可使用下面的目录下载。不要把 `pull --job` 当作数据集下载。

### 上传目录（支持续传）

普通成员可以上传个人数据，不需管理员逐份代传。先选机器：

```sh local
gpuctl data upload ./my-data --name my-data
gpuctl data upload-status UPLOAD_ID
```

保持同一目录、机器和名称，重复原上传命令可续传；期间不要修改目录。显示 `READY` 后复制返回的完整数据集 ID、64 位版本和训练路径，ID 可能与输入短名不同。

支持直传的新版客户端会显示实际传输路径。管理员启用上传节点、且你的网络能直达它时，文件直接到服务器，不经过平台中转；不需要额外的 Tailscale 账号或服务器密码。直传断开不会偷偷改走中转，重新执行原命令即可核对并续传。

没有直传入口时，小目录可走平台中转；**超过 256 MiB 默认停止并提示选择**。优先使用校内网络或链接导入。确实要使用平台带宽时，在原上传命令后加 `--via relay`；只允许直传可加 `--via direct`。网页目录上传仍走平台中转，大目录需要勾选确认；不要把网页上的「上传」理解为已经开通校内直传。

仅当想放弃未完成上传时执行下面命令；不要跟着正常上传步骤一起运行，不删除就绪版本：

```sh local
gpuctl data upload-discard UPLOAD_ID
```

### 上传压缩包，手动整理后发布

网页「数据集 → 添加数据 → 个人数据空间」中的个人数据终端，`/data2` 只对应**你在当前服务器上的可写目录**，不是整块数据盘；其他用户的数据、已发布版本和 GPU 不可见。CLI 在自己电脑执行：

```sh local
gpuctl data put samples.zip
gpuctl data shell
```

进入数据终端后：

```sh data
mkdir -p samples
unzip samples.zip -d samples
exit
```

压缩包不会自动解压；先检查来源、解压大小和空间。数据终端没有 GPU；`gpuctl data files` 查看目录，`gpuctl data shell --reconnect SESSION_ID` 重连。`put` 经过 VPS 中转，超过 256 MiB 需明确加 `--via relay`，网页也会先请求确认；大文件优先链接导入。单文件上限 100 GiB，`put` 暂不自动续传；重新上传覆盖需明确加 `--overwrite`。

结束这台机器上自己的所有数据终端，回到自己电脑发布：

```sh local
gpuctl data publish samples --name samples
gpuctl data workspace-status OPERATION_ID
```

发布期间不能修改数据目录；只断开终端不够。显示 `READY` 后用返回的引用训练。发布保留可写目录并生成独立只读副本，需要两份空间；之后修改草稿不影响已发布数据。未启用内核配额的节点，手工写入尚无独立磁盘硬配额；大规模解压先核对空间。开通节点的个人 byte/inode 上限由管理员配置，超限会拒绝写入，不自动扩大容量。

### 使用数据训练

数据集页合并显示自己获授权机器上的版本和就绪位置。选择本次训练机器：本机已就绪的版本可以直接使用；有可用来源时点「准备到本机」，或「准备后训练」。管理员启用节点间私网传输后，平台可将其他已授权机器上的固定 READY 版本复制过来，文件字节不经过 VPS。仅看到其他机器有数据，不保证通道已启用或当前能复制；状态未知时不会申请 GPU。

容量栏是服务器共享数据盘的剩余空间，不是个人硬磁盘配额。即使节点另行开通个人配额，也不要把这个数当作自己的额度。某台机器查询失败会显示部分结果，不代表那里没有数据。

### 可选的长期保存与本地缓存

管理员启用并验收 0.4.3 的自动归档后，**之后新上传或发布的个人版本**会在后台保存到指定 HDD 原件，再认证本地训练缓存。上传到哪台机器、在哪台机器训练仍由你选择，不会默默换机；读取自己的归档也不需要 HDD 机器的 GPU 额度。旧数据默认受保护，不会自动搬迁或补归档。页面没有长期保存状态时，不要假设已启用。

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

网页上传和 `data put` 仍经过平台中转；`data upload` 的实际路径以客户端显示为准，直传需要管理员配置并核验入口。链接导入由服务器直接下载，不经过自己的电脑或平台文件中转。数百 GB／TB 本机数据优先校内直传或外接硬盘导入，不要因为单文件允许 100 GiB 就默认用 `data put` 传大文件。单份清单最多 500,000 条且不超过 64 MiB，空间还受节点和账号限制；平台副本不是备份。

### 持续传输（需传输任务新版）

这部分是管理员启用后的可选能力，不会因更新客户端自动开放：门户、节点和客户端都需支持，LAN copy 还需管理员配置并核验节点间接口。没有「传输任务」入口时使用上面的上传和链接导入；指南包含命令不代表功能已上线。下面的 VERSION 用完整 64 位版本替换。

```sh local
gpuctl transfer upload ./my-data --name my-data
gpuctl transfer download DATASET_ID@VERSION ./new-download
gpuctl transfer list
```

上传和下载重复同一命令可续传，但电脑离线不能继续提供或接收文件。下载到新目录，不覆盖已有目录；全量 SHA256 通过才完成。网页「数据集」上传进入传输列表。

配套新版下载在整次读取期间保留读取保护，断线不会自动过期；完成或明确取消才收尾。旧 `sync data` 没有整次读取保护，对开启 GC 的 cache 版本会明确拒绝，应改用新版 `transfer download` 或从受保护原件读取，不会自动换源。

```sh local
gpuctl transfer copy DATASET_ID@VERSION --from SOURCE --to TARGET --name my-data --detach
gpuctl transfer status TRANSFER_UUID
gpuctl transfer watch TRANSFER_UUID
```

服务器间 copy 在 LAN 后台执行，不占 GPU，关电脑仍继续；只复制固定数据集版本，不迁移训练或环境。`WAITING_CLIENT` 等待本机，`VERIFYING` 校验，`UNKNOWN` 未确认，不会自动换机或重跑。复制请求丢失时用打印的原 `--key` 重试；只在确认停止为 FAILED / PAUSED 时用 `gpuctl transfer resume TRANSFER_UUID` 恢复原任务。

数据页中的“传输与导入”（左侧“传输任务”）按“需要处理”“进行中”“已完成”分组；“已加载”是当前页记录，不是所有任务总数。若还有下一页，继续加载后再核对完整记录。停止传输保留未完成文件，不会自动重跑。

```sh local
# 仅在确定放弃这一项传输时执行，终止后不可恢复；保留断点供检查
gpuctl transfer cancel TRANSFER_UUID
```

训练通过 `run` 已经持续运行，不靠 tmux；网页交互终端仍有时限。传输任务负责版本的上传、下载和节点间复制；后台 URL 下载使用上面的 `data import`，二者不是任意长 CPU 脚本执行入口。旧 push、单文件 pull、sync git/code 保持原行为。

## 日志与结果 {#results}

### 队列、进度和错误

```sh local
gpuctl jobs
gpuctl watch JOB_ID
gpuctl logs JOB_ID
gpuctl diagnostics JOB_ID --json
```

`watch` 默认每 5 秒核对，`--interval 1` 可调整；Ctrl+C 只停止查看。完成、失败、取消或状态未知时反馈并退出，断开连接后可再次 `watch`；不会取消、恢复或重试训练。

网页任务表可显示轮次、步数和训练上报 ETA。准确进度需要程序接入 `gpuq.progress.ProgressReporter`；未适配显示「进度未上报」，仍可看日志。训练上报 100% 或异常不是调度终态。`RUNNING` 不保证每个 worker 都健康；先看最近 200 行主日志，再看 worker 诊断、退出原因和历史分配。

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

同等级不互抢，`never`、旧 `legacy`、共享和外部进程不被这些新模式强杀。请求的卡数、个人额度和节点能力仍要满足，缺能力会拒绝，不会自动换机或降级。旧 `--priority idle|normal|high` 仍兼容，但不能与上述自定义选项混用；其中 `idle` 允许结束任务，不自动保存或重跑。

管理员可修改已核验待启动任务的排队等级：`gpuctl priority JOB_ID P1`。只改排序，不改让位和恢复，不作用于已运行任务。

### 额度和团队交流

排队、启动、运行和状态待确认的任务都会计入你的额度；弹性任务按最大卡数占用。每台机器的卡数上限与所有机器合计上限同时生效；合计上限不会自动替你挑机器。额度不保证立即有空卡，有额度也可能等卡。不要用瞬时 0% 利用率判断显卡空闲。

协作区只有“帖子”和“聊天”两个入口；桌面并排显示，手机用标签切换。帖子用于公告和问题反馈，聊天用于即时交流；留言不会自动改变配额、队列或取消任务。反馈问题注明机器、任务 ID、时间和复现步骤，不要粘贴密码、令牌、私钥或私密训练数据。

## 常见问题 {#troubleshooting}

### 页面提示维护中

维护横幅会显示全平台或指定机器的原因。维护期间暂停新训练、个人终端新建/重连与输入、文件上传/写入、发布、数据准备、传输启动/续传和自动归档推进；仍可看历史、日志、状态，取消任务/传输，以及关闭或断开终端。已有上传与停止尚未确认的保护不会被自动删除。网页与 CLI 使用同一维护限制。

维护状态重启后仍保留，只有管理员明确恢复才解除。开启维护**不会自动结束已有任务、终端或节点后台服务**，也不等于服务器已停止；实际诊断维修由管理员另行安排。解除后，未取消的准备/等待任务可继续；已取消或其他终态任务不会自动重跑。已运行的训练通过原调度系统停止后，仍须等待终态确认。管理员独立 ROOT 运维入口保留，个人开发入口不豁免。

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

发布前结束所有项目开发终端，不能只断开；检查错误提示中属于自己的文件和链接。不要给系统目录批量改权限。训练和开发终端的 HOME 不同，默认缓存不会自动带进训练；个人小体积模型权重放 `/workspace/weights` 后随项目发布即可，无需每次重新上传。

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

项目终端可以安装个人 Python 包、编译自己的依赖。节点开通个人容器环境后，新项目可选择 OCI 模式，在容器内安装系统包；这不会修改宿主机。现有共享/隔离 Python 环境继续可用，但不能通过 `sudo apt` 修改宿主机。若节点尚未开通 OCI，请在“协作区 → 帖子”说明缺失依赖和错误，让管理员评估安装。个人容器的镜像、可写层、代码、数据和输出均计入该账号的数据卷硬配额。

旧维护申请流程已停用，不能提交脚本申请 root，也不需要为普通开发和训练申请审批；已有申请只保留历史查看。原有系统账号、原生 SSH、Tailscale 是独立入口，平台注册不授予这些权限。

### 登录过期或换账号

登录会话保存在门户数据库；保留原数据库时，重启／更新门户不需要重新登录。默认 30 天未使用才过期，正常使用自动续期；浏览器凭据缓存一年，CLI 缓存保留到主动退出，不保存明文密码。

首次从旧版升级需重新登录一次，旧内存会话无法恢复。主动退出只撤销当前登录；管理员改密码、停用账号或改角色会撤销该账号所有登录。浏览器清理 Cookie、凭据缓存满一年，或更换平台地址，也需要重新登录。

确实过期时用 `gpuctl login`，主动退出用 `gpuctl logout`；换账号后重新选服务器和项目。登录失效不会停止已经提交的训练。
