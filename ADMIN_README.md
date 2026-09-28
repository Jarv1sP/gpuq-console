# AMAX 管理员手册

入口：https://gpu.example.com（替换为自己的域名）。初始管理员密码保存在 VPS 的 `data/bootstrap.json`，仅本机管理员可读；生产密码与邀请码请放在自己的私有密码管理器中，不提交本仓库。

## 日常管理

1. 左侧“用户授权”→“注册邀请”，复制当前有效注册码给新用户；随时可重新打开查看或换新。
2. 对方自行注册并进入零额度资源页；所有管理员的“待处理”会自动出现该账号。选择用户，批准机器、每机卡数与总数。
3. “授予全部机器最大额度”给清单内所有卡的使用上限，但仍是普通用户。
4. 提升为“管理员”授予账号管理、他人任务管理，以及已明确开启 root 功能节点的宿主机终端权限。不要把它用于单纯增加 GPU 额度。

“我的工作台”只显示自己的使用；“用户授权”才处理他人权限，下方可展开全体任务。普通用户不显示管理入口。后台每 15 秒轻量同步，保留授权/训练草稿。

注册码不能授予管理员。初始 `admin` 是引导账号：注册个人账号、提升为管理员并登录验证后，可先暂停再删除旧 `admin`。至少保留一名可登录管理员，不能删除当前自己或仍有未完成任务的账号；建议每位管理员使用独立账号。

## 命令行

客户端安装见用户手册。常用：

```sh
amax login
amax users
amax grant alice --machine gpu-1=2 --machine gpu-2=4 --total 4
amax grant alice --full
amax jobs
amax cancel 任务ID
```

`grant` 整体替换策略，不是累加。不能把额度降到当前预留量以下；先明确取消相应任务，等释放后再调。网页有版本校验，避免旧页面覆盖其他管理员的新授权。

```sh
amax user reset-password alice
amax user disable alice
amax user enable alice
amax grant alice --total 0
amax user role alice admin
amax user role alice member
```

暂停、改角色、重置密码会撤销已有登录会话；暂停不会自动杀训练，需另行取消。删除只允许已暂停且无未完成任务的非当前账号（保护最后一名管理员）；`amax user delete alice` 保留历史和数据。

## Root / sudo 宿主机终端

```sh
amax use gpu-1
amax ssh --root
```

此入口是实际宿主机 root，不受个人工作区限制，可安装系统软件和管理整台机器。节点部署时需显式使用 `--enable-host-root`；默认关闭。网页需勾选“宿主机 ROOT”。普通用户调用相同接口会被后端拒绝；只有最大 GPU 额度的普通用户也不能进入。

这是高信任权限：root 能读所有文件、终止所有任务、绕过配额。管理员正常训练仍建议 `amax run -g N -- ...`，尊重 GPUQ 队列；原始 root 命令的副作用不受平台保护。终端最长 6 小时、无输入 1 小时结束，文件修改不会回滚。

## 邀请码

```sh
amax invites list
amax invites rotate member
amax invites disable member
```

普通码可复用；轮换使旧码失效但不影响已有账号。管理员随时可查看当前有效码，普通用户不能读取。数据库保存 AES-256-GCM 密文和注册核验摘要；加密密钥是数据库旁的 `.invite-key` 文件，须与私有备份一起保存。仅保存旧摘要的部署无法还原原码，需要导入已知原码或换新一次。

## 部署与兼容

- VPS `/opt/amax-console`，容器 `amax-console`；SQLite `data/portal.sqlite`，WAL + FULL 同步。
- `amax-console-executor.service` 使用本地 Unix socket，不开放公网执行端口；独立强制 SSH 命令接清单里的节点，私钥不挂网页容器。
- 状态采集超过 3 分钟拒绝新任务。执行核对每 15 秒，超时/失联保留额度，通过固定提交键防重复。
- 节点程序位于服务用户的 `~/.local/libexec/amax-console/`；工作区根目录、GPUQ 目录和 Python 由私有 `inventory.json` 指定。
- 普通终端为独立用户 systemd 单元；训练沿用 GPUQ 单元。隔离任务只挂个人目录和分配设备；NCCL 在平台内使用统一共享内存兼容设置。
- Root 入口 `/usr/local/libexec/amax-console-root-shell` 为 root 所有，专用 sudoers `/etc/sudoers.d/amax-console`。仅在确需最高权限时部署它。
- 已存在的 GPUQ 不初始化、不迁移任务、不自动重启；新节点首次启用需观察模式验收。
- 新平台使用自己的机器清单，不依赖旧 GPUQ fleet 清单。

平台额度约束经过新入口的任务，不约束持有旧 `amax`/sudo 的可信管理员。不是面向恶意公网租户的 VM 级隔离承诺；尚无每用户硬磁盘配额，训练写盘要监控。只实现整卡、同机多卡、每卡显存门槛，不自动跨机 DDP/MIG。

## 备份与维护

```sh
ssh vps /opt/amax-console/backup.sh
ssh vps 'docker logs --tail 80 amax-console'
ssh vps 'systemctl status amax-console-executor.service --no-pager'
```

重启网页后台不停止训练，后台恢复后核对持久化任务。`UNKNOWN` 未确认前不能手动清零额度。紧急停执行桥会停止新控制操作（包括取消），但不会自动杀节点训练。

备份覆盖后台数据库及注册码加密密钥，不含个人数据集、环境和模型。升级/回退保留数据库与节点 jobs/users/terminals；旧只读镜像不能代替新后台取消任务。完整验收见 [测试检查单](docs/TESTING.md)，部署与升级步骤见 [部署手册](docs/DEPLOYMENT.md)。
