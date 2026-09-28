# AMAX Console

为实验室搭建一套**账号 + GPU 配额 + 个人终端 + 训练队列**。普通用户从网页或自己的命令行登录，不必全部加入管理员的 VPN；管理员按服务器和 GPU 数量授权。后端复用 GPUQ，管理网络使用 Tailscale / Headscale + OpenSSH。

本仓库包括网页、CLI、VPS 部署、Headscale 示例、节点执行桥、GPUQ 源码、用户与管理员手册。不是只有界面的演示；同时保留一个与生产隔离的本地 demo，方便贡献者开发。

## 使用是什么样

```sh
amax login
amax use gpu-1
amax ssh                         # 安装个人环境、编辑代码
amax push .                     # 在本地项目目录上传代码
amax run -g 2 -- python train.py # 用同机两张整卡运行
amax jobs
amax logs 任务ID
amax pull output/model.pt ./model.pt
```

- 邀请码注册 → 初始零权限 → 管理员分配机器、逐机卡数和总卡数。
- 左侧切换“我的工作台”“机器资源”；管理员另有“用户授权”，自动显示待处理新用户，可查看或轮换当前注册码。
- 网页与 CLI 共用权限、任务和工作区。默认输出给人看，`--json` 用于自动化。
- 普通终端与训练共享个人 `/workspace`；安装在里面的环境不会因退出终端消失。
- 调度支持整卡、同机多卡、最低物理显存筛选；训练代码需自行支持多卡。
- 只有角色为 `admin` 且节点显式开启该能力，才可 `amax ssh --root` 进入真实宿主机。
- 命名中保留 AMAX 只是项目名称；不依赖某个品牌服务器。

## 系统结构

```text
用户网页 / amax CLI
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

Headscale 是可选的自建控制面；已有 Tailscale 网络可直接复用。普通平台用户不需要 Tail 身份。**本系统没有把家庭代理、VPN 出口节点或校园网配置绑进训练平台。**

## 从零搭建

完整可操作步骤：[部署手册](docs/DEPLOYMENT.md)。顺序如下：

1. 准备一台 Linux VPS、域名和至少一台 NVIDIA GPU Linux 服务器。
2. 建立或复用 Tail 网络，仅放通 VPS 执行节点到 GPU 服务器的 OpenSSH。
3. 克隆仓库，填写 `inventory.json`，生成部署文件。
4. 在每台 GPU 节点安装 GPUQ 和受限执行桥，确认主机指纹。
5. VPS 启动采集、执行桥、Portal/Caddy，登录后轮换注册邀请码。
6. 用普通新用户实测一次授权、训练、取消、越权拒绝，再交给团队。

```sh
git clone https://github.com/Jarv1sP/amax-console.git
cd amax-console
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
| [用户手册](USER_README.md) | 注册、命令行、安装环境、上传、训练、下载 |
| [管理员手册](ADMIN_README.md) | 用户授权、最高权限、邀请、备份、故障处理 |
| [GPUQ 手册](gpuq/README.md) | 打包、单机队列、原有高级功能与门户边界 |
| [架构与安全边界](docs/ARCHITECTURE.md) | 信任关系、配额一致性、隔离与限制 |
| [测试与发布检查](docs/TESTING.md) | CPU 自动测试与 GPU 实机验收 |
| [贡献指南](CONTRIBUTING.md) | 提 Issue / PR、分支、测试与发布流程 |
| [开源依赖与出处](THIRD_PARTY_NOTICES.md) | 每个依赖的职责、来源、许可证 |

## 本地开发

Node.js 24 LTS、Python 3.10+；生产节点要求 Linux + systemd/cgroup v2、支持用户命名空间的内核、NVIDIA 驱动和支持 `--bind-fd` 的 bubblewrap。命令行客户端最低 Node.js 22.13。

```sh
npm ci
npm test
npm run test:python
python3 scripts/build-gpuq.py
python3 build/gpuq.pyz --help
npm start
```

`npm start` 仅监听本地的内存 demo，使用明确标识的假账号，不连接真实 GPU/SSH；**不要把 demo 暴露公网**。生产入口是 `portal-server.mjs`。GitHub CI 不连接任何真实服务器，不使用部署密钥；PR 不会自动部署生产。

## 边界先说清

- 面向互相信任的实验室，不是恶意公网多租户的 VM 级隔离。持有旧服务器 sudo/共享账号的人仍可绕过门户配额。
- `amax ssh` 是 HTTPS PTY 的简写，不是原生 SSH 协议，暂不支持拿它直接连接 VS Code Remote-SSH / SFTP / rsync。
- 新门户仅开放整卡与同机多卡。GPUQ 已有的弹性、抢占、HAMi、跨机队列/同步仍属高级管理员工具，没有全部接入普通用户授权层。
- 数据传输经 VPS；无每人硬磁盘配额；日志最近 200 行；5000 条门户任务记录需要维护归档。
- root 是真实且不隔离的高风险权限；节点默认关闭，部署者明确开启后才可使用。
- 不声称“零 bug”。已有部署做过 CUDA、双卡 NCCL、任务取消、权限与重启恢复测试；从空白机器搭建仍须按验收清单测试自己的环境。

## 许可证与致谢

本项目原创部分采用 [MIT](LICENSE)。GPUQ 源码来自本项目既有实验室部署的 source zipapp，经整理纳入仓库；不是把某个同名第三方项目改名为原创。Tailscale、Headscale、OpenSSH、Caddy、xterm.js、bubblewrap、slirp4netns 等均为独立上游项目，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。NVIDIA 驱动/CUDA 不属于本仓库开源代码，也不随仓库分发。
