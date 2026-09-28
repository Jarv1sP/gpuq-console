# AMAX 用户手册

入口：https://gpu.example.com 。网页、自己电脑的命令行共用账号与任务，不需要 ChatGPT 账号，也不要求新用户加入 Tail。

## 第一次使用

管理员发给你注册码后，在网站注册自己的用户名、密码。注册成功自动进入“机器资源”，可用额度为 0；不用再找管理员手动创建账号。管理员会自动看到待处理账号，批准后你的资源页自动更新。

左侧“我的工作台”只放自己的终端、文件和训练；“机器资源”查看自己的额度。普通用户看不到“用户授权”。

电脑需要 Node.js 22.13+。只安装一次客户端：

```sh
curl -fsSL https://gpu.example.com/install.sh | sh
```

重新打开终端，然后：

```sh
amax login
amax use gpu-1
amax ssh
```

`login` 会提示用户名和密码；密码不回显。`use` 记住服务器，不必每次再写；机器名称以网站和 `amax status` 的实际清单为准，只允许你获批的机器。`ssh` 打开交互式命令行，不需要另配 SSH 密钥或服务器密码。用户名支持 2–24 个小写英文字母、汉字、数字、下划线和连字符，以字母或汉字开头。

安装命令适用于 macOS、Linux 和 Windows 的 WSL。这里的 `amax ssh` 是通过 HTTPS 连接个人终端的快捷命令，不是原生 SSH 协议端口；暂不能作为 VS Code Remote-SSH、SFTP 或 rsync 的目标。已有 Tail + OpenSSH 管理方式不变。

## 安装环境、编辑代码

普通终端进入个人 `/workspace`，与后续训练共用。比如：

```sh
pwd
python -m venv .venv
source .venv/bin/activate
python -m pip install numpy
```

个人工作区长期保留；退出终端不会删除环境和文件。管理员提供的基础 Python/Conda 只读挂载在 `/opt/conda`；已有环境位于 `/opt/conda/envs/环境名`。可安装个人 pip/venv/conda 环境，但普通账号不能 sudo 改宿主机。

终端本身不占 GPU，不挂载 GPU。验证 CUDA 或跑训练请用 `amax run`，不能绕过队列直接在普通终端拿卡。终端上限 2 核 CPU 额度、8 GiB 内存，无输入 1 小时或累计 6 小时自动结束。`exit` 结束会话；`Ctrl+]` 仅断开，再次 `amax ssh` 可接回。

## 上传并训练

在自己电脑的项目目录：

```sh
amax push .
amax run -g 1 -- python train.py
amax jobs
amax logs 任务ID
amax pull output/model.pt ./model.pt
```

`push .` 把当前目录内容上传到当前服务器的 `/workspace`。同名文件覆盖，软链接不跟随；请勿上传不需要的密钥、缓存或大数据。也能指定远端子目录：`amax push ./myproject myproject`，训练时对应 `bash -lc 'cd myproject && python train.py'`。

环境安装到 `.venv` 时，用 `amax run -g 1 -- .venv/bin/python train.py`。任务在服务器运行，关电脑不影响训练。日志为最近 200 行；`jobs` 查看新状态。

```sh
amax cancel 任务ID
```

取消后等待 GPUQ 确认停止，再释放额度；后台子进程一起清理。任务 ID 是平台返回的 UUID，不是旧 GPUQ 的 `J...` 编号。

## 多卡与显存

```sh
amax use gpu-2
amax run -g 4 --min-vram 24 --name ddp -- python -m torch.distributed.run --standalone --nproc-per-node=4 train.py
```

`-g 4` 申请同一服务器的 4 张整卡。`--min-vram 24` 筛选每张卡物理显存至少约 24 GiB 的机型，不是显存切片；驱动预留的少量容量不影响 24/32 GiB 型号匹配。训练代码必须支持多卡，不会自动改写程序。

显式 `amax run auto -g 2 --min-vram 32 -- python train.py` 可在已批准的机器里自动选择；代码和数据要先准备到候选机器，不会自动搬运。首次使用建议指定机器。当前不自动将跨机显存合并或启动跨机 DDP。

## 机器与配额

| 名称 | GPU | 每卡显存 |
|---|---|---|
| gpu-1 | 8 × RTX 5090 | 32 GiB |
| gpu-2 | 8 × RTX 4090 | 24 GiB |
| gpu-3 | 6 × RTX 4090 | 24 GiB |
| gpu-4 | 8 × RTX 3090 | 24 GiB |

上表仅为示例部署，实际名称、型号和容量由管理员配置。

管理员设置每机用卡上限与跨机同时用卡总数。排队、启动、运行和状态待核对都计入额度，成功/失败/取消确认后释放。授权不是物理卡预留；没有空闲卡会排队，不抢占现有实验。

普通终端与训练只看见个人目录，训练仅挂载获配 GPU。清空 `CUDA_VISIBLE_DEVICES` 也不能多拿其他卡。每台机器工作区独立，不自动同步。训练系统内存默认每 GPU 32 GiB、CPU 每 GPU 4 核额度；不是 GPU 显存限制。

## 网页也能做什么

登录后可打开终端、上传文件、提交训练、看日志、取消任务、下载结果。网页里的“断开”保留终端，“结束终端”才关闭。浏览器下载超过 100 MiB 请用 CLI；文件经 VPS 转发，不是高速直连传输。API 单文件上限 100 GiB，磁盘剩余不足 10 GiB 拒绝新上传。

## 常见情况

- 超出额度：减少卡数、等待自己的任务结束，或请管理员增加额度。
- `UNKNOWN`：节点状态暂不确定，后台每 15 秒核对，保留额度，不等于任务停止。
- 机器状态过期：暂拒绝新提交，已有训练不受影响；联系管理员。
- 提交超时：用输出的 `Submission key` 加 `--key UUID` 和相同参数重试，避免重复任务。
- `FAILED`：先 `amax logs 任务ID`。原宿主机共享路径没挂载，不表示文件被删除。
- 下载拒绝覆盖本地已有文件；换目标文件名。
- 会话过期：重新 `amax login`。`amax logout` 主动退出。

默认输出为可读的任务列表、状态和原始日志；任务列表显示最近 50 条。进阶脚本可加 `--json` 获取完整结构化输出；密码支持 `--password-stdin`。平时不需要这些参数。原服务器 `gpu` 工具保留给旧用户，平台统一使用 `amax`，正式训练不用演示接口 `request/release`。
