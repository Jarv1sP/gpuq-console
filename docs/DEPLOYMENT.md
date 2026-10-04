# 从零部署 GPUQ Console

本文面向新的实验室。已有服务请先备份、比较差异，不把示例覆盖到正在使用的 Tail 策略、GPUQ 数据库或反向代理。**所有命令里的域名、IP、账号和路径都是示例。**

本文统一使用厂商无关的 `gpuq-console` 服务/目录前缀、`gpuops` 系统服务用户和 `/srv/gpu-workspaces` 工作区。已有安装不自动改名或搬迁，升级前先读[名称更新与兼容](MIGRATION.md)。

## 1. 准备条件

- 一台有公网域名的 Linux VPS；公网开放 TCP 80/443，管理 SSH 仅允许可信来源。建议至少 1 GiB 内存。
- VPS 安装 Docker Engine / Compose v2+、Git、Node.js 24、Python 3.10+、OpenSSH client、sqlite3。
- GPU 节点：Linux、Python 3.10+、systemd 用户服务/cgroup v2、NVIDIA 驱动、OpenSSH server、bubblewrap（`bwrap --help` 包含 `--bind-fd`）、slirp4netns、curl。
- GPU 节点允许用户命名空间。某些 Ubuntu/AppArmor 策略会限制它；使用发行版支持的规则授权相关程序，不全局关闭系统安全机制。
- 每台节点准备一个可信的非 root 服务用户（示例 `gpuops`）和只读基础 Python/Conda（示例 `/opt/conda`），其中 PyTorch/CUDA 与驱动兼容。不要给新平台普通用户发这个系统账号的密码。
- 给域名 `gpu.example.com` 设置指向 VPS 的 A/AAAA；不要保留指向错误主机的 AAAA。Caddy 负责自动申请/续签证书。

## 2. Tail 管理网络

### 已有 Tail / Headscale（推荐复用）

把 VPS 与 GPU 节点加入现有网络；保留其他设备和策略。VPS 用 `tag:portal`，GPU 节点用 `tag:server`。**合并** [policy.hujson](../deploy/policy.hujson) 中的必要规则，让 portal→server TCP22；管理者可单独用 `tag:owner`。实际所有者名称以自己的控制面为准。

本平台使用普通 OpenSSH，不需要 Tailscale SSH；如果节点已启用 Tailscale SSH，需在已有管理通道确认 OpenSSH 可用后关闭该功能，不能在唯一远程连接上冒险切换。只打管理隧道，不宣告 exit node、不修改默认路由或 DNS。

### 可选：自己新建 Headscale

仓库提供 Headscale 0.29.3 的独立示例，参考 [官方配置](https://github.com/juanfont/headscale/blob/v0.29.3/config-example.yaml) 与 [策略文档](https://headscale.net/development/ref/policy/)。在同一 VPS 使用时增加 `tail.example.com` DNS。先完成下面第 3 节生成配置；启动前用自己的身份修改 `tagOwners`。

```sh
docker compose --profile headscale up -d headscale caddy
docker compose exec headscale headscale users create owner
docker compose exec headscale headscale users list
```

客户端安装官方 Tailscale 后运行（VPS 示范）：

```sh
sudo tailscale up --login-server=https://tail.example.com --hostname=gpu-portal --accept-dns=false --advertise-tags=tag:portal
```

在管理端按客户端返回的登记提示批准，`--user` 使用上一步真实用户 ID/名称。0.29 系列示例：

```sh
docker compose exec headscale headscale auth register --auth-id 登记请求ID --user 用户ID
```

GPU 节点同理，改为自己的 hostname 与 `tag:server`。登记是一次性受控操作，不把长期可复用授权密钥写 README 或 shell 历史。手机等个人设备不是部署必需。

若策略引用用户尚不存在导致服务拒绝启动，首次启动先把策略保存为 `{"acls":[]}`（默认拒绝），创建 owner 后再恢复此仓库策略并重启 Headscale；不要临时 `*:*` 全放通。已有网络绝不执行这种初始化。

已有独立 Headscale 时不启用该 Compose profile，可删除 Caddyfile 第二个域名块；它不影响已有控制面。

## 3. 配置 VPS 源码

以 VPS 管理员操作：

```sh
sudo git clone https://github.com/Jarv1sP/gpuq-console.git /opt/gpuq-console
cd /opt/gpuq-console
sudo cp config/inventory.example.json inventory.json
sudoedit inventory.json
sudo node scripts/configure.mjs inventory.json
sudo python3 scripts/build-gpuq.py
sudo python3 deploy/init-vps.py
```

填入 `publicOrigin`、`headscaleOrigin`、真实 `vpsTailIP`，以及每台 GPU 节点的稳定 ID、Tail IP、SSH 服务用户、卡数/型号/显存、工作区/GPUQ/Python 目录。不要用中文作系统服务用户；门户用户名可以是中文。`memory` 用例如 `24 GB`。

`configure` 生成公开的机器容量表和私有 `.env`/Headscale 配置；`init-vps` 建目录、初始管理员密码、两把独立 Ed25519 密钥、systemd 单元，但不启动服务、不修改 ACL、不进入节点。

`init-vps` 会把安装根目录规范为 `root:root / 0755`，私有清单与管理密钥保持 `root:root / 0600`，数据目录保持应用的 UID/GID 1000；不递归修改已有数据库、邀请码密钥或工作区。若通过压缩包交付，不要直接将带有本机 UID/目录权限的归档解压覆盖生产根目录：用 GNU tar 的 `--no-same-owner --no-overwrite-dir` 解压到独立暂存目录，核对后只安装允许更新的软件文件，排除数据、清单、密钥及根目录元数据。更新后重新检查目标目录的属主和可遍历权限，不能靠扩大服务 capability 绕过权限错误。

私钥在 `collector/id_ed25519`、`executor/id_ed25519`，**永远留在 VPS**。只复制 `.pub` 到对应 GPU 节点。

## 4. 准备 GPU 节点

安装系统依赖，确认驱动和现有实验正常；以 `gpuops` 登录，准备源码（相同版本）、自己的 `inventory.json` 以及 VPS 两个公钥。各节点只需这个清单中的自身条目和 VPS Tail IP，也可使用完整私有清单。不要复制 VPS 私钥或数据库。

首次建目录的例子，须与自己的 inventory 一致：

```sh
sudo install -d -o gpuops -g gpuops -m 700 /srv/gpuq /srv/gpu-workspaces
sudo loginctl enable-linger gpuops
python3 scripts/build-gpuq.py
python3 deploy/install-node.py --inventory inventory.json --node gpu-1 --collector-key collector.pub --executor-key executor.pub --initialize-gpuq
```

安装器在服务用户下运行，不能 `sudo python3 install-node.py`。用户 systemd 要可用：`systemctl --user status`；若第一次启用 linger 后仍无用户总线，重新登录该服务用户。

安装前会运行短暂的非 GPU 任务，读回真实 CPU / 内存 / PID 限额。若 CPU 未委派，可经管理员确认给安装命令添加 `--configure-cpu-delegation`：只为当前服务 UID 写独立、带备份的 systemd drop-in，保留原委派项并添加 CPU，不添加控制台 sudo 权限。活跃用户管理器不会被自动重启或 reexec；探针仍失败时停止替换节点程序，按 [CPU 委派与 Ray 资源说明](RAY_RESOURCES.md#安装前的-cpu-委派检查) 在维护窗口确认后完成原位刷新，再重跑安装。

- **已有 GPUQ**：不传 `--initialize-gpuq`，`gpuqRoot` 指向现有 config 所在目录，保留已有 `~/bin/gpu`。安装器不会迁移数据库、升级或重启原 GPUQ。
- **新 GPUQ**：显式初始化后以观察模式启动，保守检查 `nvidia-smi`、`~/bin/gpu health`、`~/bin/gpu status`；确认 GPU UUID 和现有占用后执行 `~/bin/gpu set-mode --active`。它不会为了接入而杀已有实验。
- **可选最高权限**：同一安装命令增加 `--enable-host-root` 才安装固定 root 入口与 sudoers。这让门户 admin 获得真实宿主机 root，应只给完全受信任的人。以后重新部署仍需显式传该开关，否则节点配置关闭此能力。

节点程序在 `~/.local/libexec/gpuq-console`，状态/数据放自己的工作区根。授权公钥带 `restrict`、VPS Tail 源地址和强制命令；不会覆盖已有 authorized_keys。修改 VPS Tail IP 后需审查并更新这些限制。

## 5. 固定 SSH 主机指纹

在每台节点可信终端查看：

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

在 VPS 获取候选公钥，与刚才指纹**逐一核对**后加入两份 known_hosts；`ssh-keyscan` 本身不验证身份：

```sh
ssh-keyscan -t ed25519 100.64.10.11 > /tmp/gpu-1.hostkey
ssh-keygen -lf /tmp/gpu-1.hostkey
# 确认与节点输出完全相同后：
sudo sh -c 'cat /tmp/gpu-1.hostkey >> /opt/gpuq-console/collector/known_hosts'
sudo sh -c 'cat /tmp/gpu-1.hostkey >> /opt/gpuq-console/executor/known_hosts'
```

对每台重复。不得把 `StrictHostKeyChecking` 改为 no。端口按当前脚本固定22；非标准端口需要先适配清单/桥并测试，不能只改 SSH alias。

## 6. 启动后台与网页

```sh
sudo systemctl enable --now gpuq-console-executor.service
sudo systemctl start gpuq-console-collect.service
sudo systemctl enable --now gpuq-console-collect.timer gpuq-console-backup.timer
sudo cat /opt/gpuq-console/status/snapshot.json
sudo docker compose up -d --build gpuq-console caddy
sudo docker compose logs --tail 50 gpuq-console caddy
```

所有节点应 `reachable:true` 且 `gpuq.connected:true`。只读状态失败时别先开放公网 SSH；先核验 Tail ACL、指纹、强制命令、服务用户总线与路径。

执行桥的 `/run/gpuq-console-executor` 目录被门户绑定到 `/executor`，单元必须保留 `RuntimeDirectoryPreserve=yes`：单独的 stop/start 也不能删除并重建该目录（`restart` 取值不足以覆盖这种操作）。已有部署应先审查并更新对应执行桥单元、执行 `daemon-reload`；保留原服务名与路径，不要为此重跑首次安装器。若运行中的容器已绑定旧目录，仅修改单元不能修复：在受控维护窗口以原镜像、原数据挂载重建门户，核验宿主机与容器目录身份及登录后的只读节点请求，不能仅凭 `/healthz` 判定恢复；不回滚数据库。`/run` 在重启后仍会清空，开机时须先准备执行桥目录再创建门户容器。

访问自己的域名。初始管理员用户名 `admin`，随机密码只在 VPS 的 `data/bootstrap.json`，用 `sudo cat` 在可信终端读取；不要截图公开。数据库已存在时不会被 bootstrap 重置。首次登录更改密码，将私有密码安全保存，并删除不再需要的 bootstrap 明文（数据库备份不含明文密码）。

在“用户授权 → 注册邀请”生成普通注册码；管理员以后可随时查看当前码或刷新换新。新用户自行注册后自动进入零额度资源页，管理员的“待处理”列表自动出现该账号，批准机器和卡数后即可使用。

管理员也建议使用个人账号：普通注册、由初始 admin 提升角色，再用个人账号登录验证完整权限。确认无未完成任务后暂停并删除初始 admin；系统保护最后一名可登录管理员，不能删除当前自己。删除不抹除历史作业和个人工作区。

注册一个普通测试账号、批准额度，执行 [完整验收](TESTING.md)。普通用户从自己的门户下载 CLI，下载内容自动带本站地址；直接从 GitHub 源码运行时首次用 `node cli.mjs --url https://gpu.example.com login`。

## 7. 备份、升级与回退

门户的持久准入维护状态位于同一 SQLite 的 `operational_maintenance` 表，与已停用的 `maintenance_requests` 申请记录独立。管理员通过网页或 `maintenance.set`（范围、原因、revision CAS）明确启用/解除，重启、任务结束或刷新页面不会自动解除；保留完整数据库备份，不能用旧账号快照覆盖维护决定。维护封锁新派发、个人终端输入和数据写入，允许只读查询、取消及终态租约收尾；后台准备/归档也在实际派发前检查。它不停止已运行训练、已有节点复制/导入 worker、直传已发行票据、GC timer 或原生 SSH，因此迁盘前仍必须由管理员完成相应节点的停止与静默核验，不能把横幅当作已静默证明。独立管理员 ROOT 运维入口仍需门户可信身份及节点既有授权检查。

`backup.sh` 用 SQLite 在线备份并验证完整性，同时备份数据库旁的注册码加密密钥 `portal.sqlite.invite-key`，每日 timer、默认保留14天。恢复时数据库与密钥必须匹配；有注册码密文但密钥丢失时，服务拒绝自动生成新密钥覆盖。另备份私有 inventory/.env、Headscale 数据与密钥、节点 GPUQ 数据库、个人工作区；只有门户 SQLite 不够恢复模型和数据集。备份放离机的私有存储，定期演练恢复。

节点文件可另行配置 [独立磁盘备份](STORAGE_BACKUP.md)。该可选助手不随升级启用，也不替代数据库在线备份；必须逐机确认来源、独立物理盘、口令留存和真实恢复结果。

升级不要对运行目录无脑 `git pull && up`：

1. 记录 Git commit、镜像 ID；运行数据库备份；保留旧节点桥与 GPUQ 版本。
2. 在独立目录检出新版，运行测试、生成自己的容量配置；比较数据库兼容性与 release notes。
3. 只替换经审查的 Portal/节点桥。GPUQ 有在跑任务时不要更换其 archive 路径或重启用户服务。
4. 重建/重启门户不会杀现有训练，但短暂影响登录和控制；确认状态恢复、不重复提交，再结束维护。
5. 回退镜像前核对数据库 schema，不能把旧快照直接盖回仍有新任务的状态库。需要还原数据库时先停控制入口并逐节点核对真实作业。

新加机器先部署节点、校验指纹，再更新清单并生成容量表。更改现有 machine ID 等同迁移身份，有未完成任务时不要改。删机器先清空任务/授权，再迁移数据，不直接删数据库记录。

### 已有节点加入项目工作流

此升级入口只用于已完成公共 P0 终端与诊断安装的节点，不负责首次安装或修复 P0 协议。先把新版源码放在节点服务用户拥有的独立目录，以该服务用户明确选择已有运行档位并检查（不是 root）：

```sh
python3 deploy/upgrade-projects.py --directory "$HOME/.local/libexec/gpuq-console" --runtime-profile common-p0
# 检查通过后才应用
python3 deploy/upgrade-projects.py --directory "$HOME/.local/libexec/gpuq-console" --runtime-profile common-p0 --apply
```

已经使用完整 Ray P0 的节点须把两条命令中的档位改为 `--runtime-profile ray-p0`；参数没有默认值，项目升级不能把已安装的 Ray runner 降级成公共档。Ray 档在任何备份或程序写入前运行有时限、无 GPU 的 CPU/内存/PID 内核限制检查；失败立即停止。升级器不接受 `--configure-cpu-delegation`，不会调用 sudo、设置委派或刷新用户管理器；需要管理员处理的前置问题见 [RAY_RESOURCES.md](RAY_RESOURCES.md)。公共档不运行该 CPU 探针。

升级器只读检查现有独立终端写入租约接口、终端返回协议、诊断采集与回收接口，以及同程序目录的诊断 GC service/timer 已安装、启用且运行。缺失或不兼容时，先按经审查的 `deploy/install-node.py` 完成配套 P0 安装。三条安装/升级路径统一使用 `deploy/node-runtime.json`，配套更新运行时助手、runner 和节点入口；不会修改 systemd 单元、启动宿主机命令或赋予额外权限。

旧部署若使用不同程序目录，替换 `--directory`，诊断 GC service 必须已指向这个目录；不要为升级改名或迁移工作区。Ray 档另配套安装 `job-resources.py` 和 `gpuq-ray`。全部源码先校验并固定字节，依赖（含 scheduling-policy、project-store、training-control）先复制，runner 随后，dispatcher/probe 最后更新。任一依赖缺失或语法错误会在写入前停止；不要手工只复制 node-executor。原文件和配置保留私有备份；项目升级保持配置原字节，数据升级沿用原有 datasets/conda 增补，默认保留已有 common/Ray 档。GPUQ 数据库、旧工作区和运行任务保持不变，不重启节点服务。

这是逐文件原子替换，不是整个运行时同时切换。升级前暂停新训练派发和新节点操作，禁止并发升级；已经运行的训练继续。全部入口复制完成后，先执行下面的部署检查及只读节点 probe，再恢复入口。PR #5 的保存/恢复策略依赖 PR #4 训练控制协议；此修复分支已合入该协议，维护者应先审阅该依赖。

```sh
python3 tests/node-runtime-deployment.test.py
python3 scripts/test-python.py
npm ci --ignore-scripts
npm test
```

部署测试使用临时节点、真实安装/升级复制和独立 Python 进程导入入口；只模拟外部 mount/systemd/CPU 检查，不使用生产 GPU。`--reproduce-pr5` 是可选的旧故障复现，需要本地保留旧提交 834d4d6；常规测试不依赖该 Git 历史。真实节点还需在本机按实际程序目录验证入口与只读 probe，无误后恢复派发。

所有目标节点完成后，再部署同版 VPS 执行桥与 Portal 镜像；前端、CLI、执行桥、节点四层必须匹配。门户控制服务重建会短暂中断请求，不表示可以停止节点实验。新版登录随原 SQLite 数据库持久化，保留私有数据卷就不因重启注销；首次从内存会话旧版升级仍需重新登录一次，不删除或初始化旧数据库。上线后按项目验收清单验证上传、开发终端、发布、单卡训练与结果下载。

回退项目功能前先停止新提交、等待项目任务和开发终端结束，再恢复备份助手及旧门户镜像。保留项目文件、结果和新数据库记录，不把旧数据库覆盖回去；代码回退不等于删除数据。

## 8. 0.4.3：分步启用归档与水位回收

自动归档和 GC 都默认关闭。此处是部署条件，不是某个实例已上线的证明；不能仅升级客户端或节点脚本就启用。已有数据根、旧目录、用户/配额和运行训练保持不变，根目录迁移必须另开维护流程。

1. 冻结完整源码和镜像清单，在隔离 Linux 环境运行配套 Python 全套及运行时部署测试；macOS 测试不能替代 Linux 挂载、systemd 和权限验收。节点必须使用 `node-runtime.json` 的完整 27 文件档位，门户镜像含 `storage-archive.mjs`，执行桥只增加 12 个明确的内部归档/租约/下载操作。先逐节点发布，再更新门户与桥，归档/GC 仍关闭。
2. 核实 HDD 权威原件根、固定 peer 证书与物理 LAN、容量、来源 ACL 和私有 grant 目录。在节点配置合并 `storageArchive: {"enabled":true,"machine":"gpu-archive","authority":"hdd"}`，其中 machine 必须替换为清单内真实权威节点，authority 与既有受信适配器名称一致。来源与目标使用相同固定策略；所有节点 `storageTier.enabled` 仍为 `false`。不让用户输入路径、端点、凭据或 cache 角色。
3. 门户以只读配置文件设置同一策略，通过 `GPUQ_STORAGE_ARCHIVE_CONFIG` 指定容器内文件。缺省不配置就是关闭；策略启用后需重建/重启门户以加载，先核对完整合并差异和可恢复备份，不覆盖现有账号、额度、工作区或数据库。
4. 用新单 owner 小样本完成真实上传/发布→HDD 固定原件→本地认证→租约防删→显式驱逐→恢复全量哈希→整次下载的验收；确认没有权威机器 GPU 额度的成员也只能读自己的原件。旧数据不会自动追溯归档，多 owner/未知状态保留保护。
5. 只有通过验收的 NVMe 节点才设置 `storageTier.enabled:true`、明确正整数 `budgetBytes` 和高/低水位 `0.8/0.7`。先查看 `data storage plan` 并做受控回收验收，再单独安装/启用可选小时 timer；HDD 原件节点保持 GC 关闭。已有安装目录与模板不同时，只改经核实的 service 程序路径，不改数据根。

归档与回收配置必须独立备份并保留完整原字节、属主/权限，写入前复核旧哈希和挂载身份；并发变更或未知状态停止。出问题先关闭 GC/timer，再关闭新归档调度，保留原件、grant、租约与持久记录供核查；这不是清除正在执行的任务，也不授权恢复旧数据库覆盖新状态。HDD 唯一原件不是异地/离机备份，结果自动归档与数据根迁移不在本次启用范围。

### 可选的工作区磁盘预留

节点 `node-config.json` 可设置顶层 `workspaceReserveBytes`（非负整数字节数，例如 `274877906944` 为 256 GiB）。未配置时保留原有工作区写入 10 GiB 预留，也不增加训练/终端启动的磁盘门槛。该字段只由管理员配置，不接受客户端覆盖；`0` 表示不留额外余量，但仍检查本次已知写入大小。数据集使用独立的 `datasets.reserveBytes`，缓存软预算使用 `storageTier.budgetBytes`，三者不是分区或可用容量相加。

工作区上传、项目发布和代码快照导入使用同一预留；显式配置后，快照索引/清单增长以及普通终端新建、新训练提交、排队任务实际启动也检查当前平台根的普通用户可用空间。检查以不跟随符号链接的目录描述符和平台根身份守卫为准；已缓存快照的读取、终端重连/日志/取消和已有训练状态查询不因空间不足而被拦截，宿主机 root 管理终端不受这项启动限制。配置需与同版完整节点运行时一起校验，不要只替换单文件。

这是**入口预留，不是硬配额**：并发写入与已运行终端/训练仍可继续消耗空间，不会被该检查主动杀停，也不为任务预占全部未来 checkpoint/输出容量。已知上传块/项目副本计入本次空间需求，快照索引仅作保守元数据估算；取消和必要收尾元数据仍允许写入。应结合容量告警、数据集回收和运维预留，不以它承诺磁盘永不写满。

## 9. 常见阻塞

- 终端打不开：`bwrap --help` 是否支持 bind-fd、用户命名空间策略、slirp4netns、服务用户 linger、基础 Python 路径。
- 单卡正常多卡失败：先查训练程序、驱动/框架兼容与 NCCL，不能通过给普通用户全宿主机权限绕过。
- 日志/状态 UNKNOWN：保留额度，查节点 SSH 和 GPUQ；不要手工清空预留。
- 证书失败：DNS A/AAAA、80/443、防火墙、Caddy 持久卷；不关 TLS 校验。
- 开源示例和既有部署路径不同是正常的；以自己的 `inventory.json` 为准，不能照抄他人地址。
