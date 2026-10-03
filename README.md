# STARBASE

把项目、数据与算力，放在同一个工作空间。STARBASE 是本项目的网页展示名称；仓库名 `gpuq-console`、后端 GPUQ、`gpuctl` 命令及已有登录配置保持兼容，不因视觉更新迁移或更名。

名称向 SpaceX 的 Starbase 基地致意；这是独立开源研究计算项目，与 SpaceX、Tesla 或 Elon Musk 无隶属、合作或背书关系。字标和界面为本项目原创，设计说明见 [品牌与界面](docs/BRAND.md)。

为实验室搭建一套**账号 + GPU 配额 + 个人终端 + 训练队列**，与服务器厂商无关。普通用户从网页或自己的命令行登录，不必全部加入管理员的 VPN；管理员按服务器和 GPU 数量授权。后端复用 GPUQ，管理网络使用 Tailscale / Headscale + OpenSSH。

本仓库包括网页、CLI、VPS 部署、Headscale 示例、节点执行桥、GPUQ 源码、用户与管理员手册。不是只有界面的演示；同时保留一个与生产隔离的本地 demo，方便贡献者开发。

## 使用是什么样

```sh
gpuctl login
gpuctl use gpu-1
gpuctl project create my-project # 创建并选中该机的项目
gpuctl push .                    # 在本地项目目录上传草稿代码
gpuctl ssh                       # 安装项目依赖，完成后 exit
gpuctl project publish
gpuctl project status            # 对应版本 READY 后再训练
gpuctl run -g 2 -- python train.py --output /outputs
gpuctl jobs
gpuctl logs 任务ID
gpuctl pull --job 任务ID model.pt ./model.pt
```

这是新版项目接口的工作流，需部署匹配的门户和节点代码；`--output` 是示例训练程序参数，请按自己的程序修改。第一次使用请先读 [使用指南](docs/USER_GUIDE.md)，其中包含 Windows PowerShell、macOS/Linux 的安装步骤；Windows 不需要 WSL。项目功能的完整实机验收范围以 [测试记录](docs/TESTING.md) 为准，不因文档更新自动视为已上线。

- 注册平台账号（不是登记设备）→ 初始零权限 → 管理员分配机器、逐机卡数和总卡数。用户电脑只需 HTTPS，不用加入 Tail，也不会被自动添加为 Tail 设备。
- “我的工作台”在手选服务器上处理自己的项目、终端、文件、任务和额度；“算力总览”显示逐卡利用率、显存、温度、功耗和 CUDA 计算进程（不含图形进程）。同机器授权成员可查看平台任务的姓名、任务名和自填描述；原始命令、日志、结果及程序／系统用户仍按原权限保护。外部／未关联任务不猜测提交者。
- 管理员专用“成员授权”处理待审批账号、角色、注册码和机器额度；网页只保留一个“使用指南”入口，按功能分章。管理员与部署手册保留在仓库，不由网站提供。
- 网页与 CLI 共用权限、任务和工作区。默认输出给人看，`--json` 用于自动化。
- “数据集”支持成员上传自己的目录，或准备管理员分配的固定版本：校验到服务器本地 `/data2` 后，用 `run --data 名称@版本` 只读挂载训练。个人上传按账号隔离，网页与 CLI 均支持断点续传；批准的跨节点来源可走实验室内网。未就绪不会占卡等待复制。
- 新项目分离草稿代码、私人 venv 与每次训练产物；发布后训练只读使用固定代码/环境版本，结果写 `/outputs`。普通终端安装依赖不覆盖基础 Conda。旧个人工作区与任务保留。
- 用户选择服务器，默认由节点分配所需数量的整卡；节点确认能力后也可显式固定卡号或主动单卡共享。不再接受新 `run auto`，不会因为该机忙碌或数据未就绪偷偷换机。支持同机多卡和最低物理显存筛选；训练代码需自行支持多卡。
- 只有角色为 `admin` 且节点显式开启该能力，才可 `gpuctl ssh --root` 进入真实宿主机。

节点约每分钟采样、页面每 15 秒同步最近快照；缺失、不可达或过期状态不会显示成空闲。新用户未获批前仅查看机器容量，不获得实时节点监控或终端权限。

## 系统结构

```text
用户网页 / gpuctl CLI
        │ HTTPS
        ▼
VPS: Caddy → Portal (Node.js + SQLite)
                    │ 本地 Unix socket
                    ▼
             受限执行桥 / 只读采集
                    │ Tailscale 网络 + OpenSSH 强制命令
                    ▼
GPU 服务器: 节点桥 → GPUQ → systemd 作业 → 个人隔离工作区 + 获配 GPU
```

Headscale 是可选的自建控制面；已有 Tailscale 网络可直接复用。Tail 仅用于 VPS 到 GPU 节点的管理通路，用户端浏览器和 CLI 通过 HTTPS 连接门户。平台注册不创建系统 SSH 账号，也不授予原有 Tail + OpenSSH 的直接登录权限；`gpuctl ssh` 提供个人工作区终端。**本系统没有把家庭代理、VPN 出口节点或校园网配置绑进训练平台。**

## 从零搭建

完整可操作步骤：[部署手册](docs/DEPLOYMENT.md)。顺序如下：

1. 准备一台 Linux VPS、域名和至少一台 NVIDIA GPU Linux 服务器。
2. 建立或复用 Tail 网络，仅放通 VPS 执行节点到 GPU 服务器的 OpenSSH。
3. 克隆仓库，填写 `inventory.json`，生成部署文件。
4. 在每台 GPU 节点安装 GPUQ 和受限执行桥，确认主机指纹。
5. VPS 启动采集、执行桥、Portal/Caddy，登录后轮换注册邀请码。
6. 用普通新用户实测一次授权、训练、取消、越权拒绝，再交给团队。

```sh
git clone https://github.com/Jarv1sP/gpuq-console.git
cd gpuq-console
cp config/inventory.example.json inventory.json
# 编辑自己的域名、Tail 地址、服务用户、GPU 数量和磁盘目录
node scripts/configure.mjs inventory.json
python3 scripts/build-gpuq.py
```

`configure` 仅生成本地文件，不远程修改网络或启动服务。示例地址不是任何生产系统的凭据或资产清单。不要把填好的 `inventory.json`、`.env`、数据库、私钥、工作区或运行日志提交 Git。

## 文档

| 文档 | 内容 |
|---|---|
| [部署手册](docs/DEPLOYMENT.md) | VPS、TLS、Tail/Headscale、GPUQ、节点、初始账号、升级与回退 |
| [名称更新与兼容](docs/MIGRATION.md) | 旧客户端、登录缓存、邀请码及已有部署的保留规则 |
| [使用指南](docs/USER_GUIDE.md) | 首次上手、Windows/macOS/Linux 安装、开发、训练、数据集、结果、排队与排错；与网页指南共用正文 |
| [管理员手册](ADMIN_README.md) | 用户授权、最高权限、邀请、备份、故障处理 |
| [项目手册](docs/PROJECTS.md) | 手选服务器、草稿代码、项目 venv、固定版本与独立训练输出 |
| [数据集手册](docs/DATASETS.md) | `/data2`、固定版本、按需副本、只读来源、租约与恢复 |
| [GPUQ 手册](gpuq/README.md) | 打包、单机队列、原有高级功能与门户边界 |
| [架构与安全边界](docs/ARCHITECTURE.md) | 信任关系、配额一致性、隔离与限制 |
| [测试与发布检查](docs/TESTING.md) | CPU 自动测试与 GPU 实机验收 |
| [贡献指南](CONTRIBUTING.md) | 提 Issue / PR、分支、测试与发布流程 |
| [开源依赖与出处](THIRD_PARTY_NOTICES.md) | 每个依赖的职责、来源、许可证 |

## 本地开发

Node.js 24 LTS、Python 3.10+；生产节点要求 Linux + systemd/cgroup v2、支持用户命名空间的内核、NVIDIA 驱动和支持 `--bind-fd` 的 bubblewrap。命令行客户端最低 Node.js 22.13。

```sh
npm ci
npm run build:client
npm test
npm run test:python
python3 scripts/build-gpuq.py
python3 build/gpuq.pyz --help
npm start
```

`npm start` 仅监听本地的内存 demo，使用明确标识的假账号，不连接真实 GPU/SSH；**不要把 demo 暴露公网**。生产入口是 `portal-server.mjs`。GitHub CI 不连接任何真实服务器，不使用部署密钥；PR 不会自动部署生产。

安装客户端是 `build/gpuctl.mjs` 单文件产物，共享源码模块由锁定版本的 esbuild 构建。
`npm test` 自动先构建；直接运行测试或源码门户前先执行 `npm run build:client`。
Docker 在构建阶段生成产物，运行容器不含 esbuild。源码仍可用 `node cli.mjs`；
修改 CLI 或其共享模块后需重建下载产物，不会在每次下载时动态编译。

## 边界先说清

以下说明仓库已实现的入口与限制；代码合入不表示任何节点已部署或完成实机验收。是否可用仍取决于配套版本、节点能力核验和账号授权。

- 面向互相信任的实验室，不是恶意公网多租户的 VM 级隔离。持有旧服务器 sudo/共享账号的人仍可绕过门户配额。
- `gpuctl ssh` 是 HTTPS PTY 的简写，不是原生 SSH 协议，暂不支持拿它直接连接 VS Code Remote-SSH / SFTP / rsync。
- 门户已接入独立调度与抢占请求、弹性卡数与保存后扩卡、固定/共享选卡和可选 HAMi；各模式仍受授权、配额、训练适配与节点能力限制，详见[使用指南](docs/USER_GUIDE.md)。不自动启动跨机 DDP，也不提供 MIG 分区管理。
- 已授权用户可手动同步固定 Git commit、已发布代码或 READY 数据版本，详见[同步手册](docs/SYNC.md)。代码同步不迁移环境，完成 `CODE_READY` 后仍须在目标节点准备环境并显式发布到 `READY`。
- 用户代码/结果传输经 VPS，公共数据可走批准的 LAN 来源；无每人硬磁盘配额、自动跨机项目/环境分发、自动结果归档或独立数据备份。日志最近 200 行；5000 条门户任务记录需要维护归档。
- 同机代码+venv 发布不是封装全部基础软件的容器镜像；Slurm 适配已有源码，Slurm/Pyxis/Enroot 尚未接入生产执行链。
- root 是真实且不隔离的高风险权限；节点默认关闭，部署者明确开启后才可使用。
- 不声称“零 bug”。已有部署做过 CUDA、双卡 NCCL、任务取消、权限与重启恢复测试；从空白机器搭建仍须按验收清单测试自己的环境。

## 许可证与致谢

本项目原创部分采用 [MIT](LICENSE)。GPUQ 源码来自本项目既有实验室部署的 source zipapp，经整理纳入仓库；不是把某个同名第三方项目改名为原创。Tailscale、Headscale、OpenSSH、Caddy、xterm.js、bubblewrap、slirp4netns 等均为独立上游项目，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。NVIDIA 驱动/CUDA 不属于本仓库开源代码，也不随仓库分发。
