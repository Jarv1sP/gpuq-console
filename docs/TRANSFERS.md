# 持续运行与传输

GPU 训练用 `gpuctl run` 提交，关闭 SSH / 浏览器不会停止。它由 systemd 托管，不靠 tmux。网页交互终端仍有时限，在里面开 tmux 不能绕过；训练恢复需要训练脚本保存完整 checkpoint，不等于文件续传。

## 使用

```bash
# 本机目录上传：重复原命令可续传，仍须本机在线、文件不变
gpuctl transfer upload ./dataset --machine gpu-1 --name samples
```

```bash
# 固定版本下载到一个新目录：重复原命令可续传，不覆盖已有目录
gpuctl transfer download NAME@完整64位版本 ./download --machine gpu-1
```

```bash
# 服务器之间：后台 LAN 直传，关闭客户端仍继续，不占 GPU
gpuctl transfer copy NAME@完整64位版本 --from gpu-1 --to gpu-2 --name samples --detach
```

```bash
gpuctl transfer list
gpuctl transfer status 传输UUID
gpuctl transfer watch 传输UUID
```

```bash
# 只终止这一项；保留断点，不删除已有数据集，不自动重启
gpuctl transfer cancel 传输UUID
```

```bash
# 仅恢复已确认停止的 FAILED / PAUSED 后台 LAN 任务
gpuctl transfer resume 传输UUID
```

网页“传输任务”提供后台复制、状态核对、终止和恢复。“数据集”上传会进入同一任务列表。网页关掉后不能继续读你的电脑，重新选同一目录才能续传；服务器校验已经开始则继续校验。

`cancel` 是永久终止：最终为 `CANCELED`，不能再 `resume`。保留文件供检查，不代表可以恢复这个已终止任务。只想暂时断开本机传输就关客户端，不要 cancel；LAN 传输可以直接让它在后台跑。

未完成文件仍占用原上传配额和空间。确认不要时，可用原 `gpuctl data upload-discard UPLOAD_ID --machine 目标机器` 清理未完成上传；本机上传的 UPLOAD_ID 在 status 回执中，LAN copy 的 UPLOAD_ID 就是传输 UUID。此操作会删除未完成数据，不能清理 READY 版本，不要跟着正常步骤一起执行。

`WAITING_CLIENT`：等待本机提供/接收文件，不是后台还在下载。`VERIFYING`：后台校验/发布。`UNKNOWN`：原节点未确认，不会自动换机器、重跑或扩散传输。

CLI copy 会先打印重试键；首次请求结果丢失时，重复原命令并加 `--key 原重试键`。不要新建一项来猜原任务是否启动。下载保留 `目标.gpuq-partial-UUID` 和相邻的完成回执，校验通过才改名；不要修改这些断点文件。正常中断自动释放客户端锁，若进程被强杀留下 `*.gpuq-client-lock`，确认文件里 PID 对应的旧客户端已停止后，只移除这个锁再续传。

锁在下载电脑上、断点目录或最终目录的旁边，文件中记录本机 PID；Linux/macOS 用 `ps -p PID -o pid,args`，Windows 用 `Get-Process -Id PID` 核对。UNKNOWN 先反复 status 核对原任务；节点重新可达后会据原 unit/cgroup 回执恢复状态。没有启动回执的长期 UNKNOWN 需要管理员检查原 unit，不能靠改键绕过；确认不需要后可 cancel 固定 ID，堵住迟到启动。

这一版覆盖固定数据集目录；旧 `push`、单文件 `pull` 和 `sync code/git` 保持原行为，不声称已具备此后台续传能力。URL／云盘后台导入使用独立的 [云端导入接口](CLOUD_IMPORT.md)，不经 LAN copy 搬运文件。普通用户的任意长 CPU 脚本和跨机训练自动迁移不在本接口内，也不通过给予 root 实现。

客户端下载回执只能独占发布到不存在的文件名；已有不同内容、软链接或硬链接会拒绝，不覆盖目标。实现使用私有随机临时文件、文件同步及原子硬链接发布；支持 POSIX 和 Windows NTFS，文件系统不支持硬链接时明确失败，不降级为覆盖写入。中断前已发布的相同回执可复用，最终目录仍须完整 SHA256 校验。

## 服务端集成

`transfers.capabilities {machine}` 只读查询当前账号获授权节点，返回：

```json
{"machine":"gpu-2","enabled":true,"sourceReady":false,"sources":["gpu-1"],"protocol":"lan-transfer-v1"}
```

`enabled` 表示目标的本地存储配置及用户 systemd 管理器可用；`sourceReady` 表示本节点的可选只读 TLS 监听通过实际探测；`sources` 只含本账号获授权、管理员明确配置且证书 pin 与实时只读协议探测均通过的源机器 ID。不会返回地址、证书或令牌。旧节点、离线和未配置状态默认不可用。能力不保证某个数据集的授权／容量或将来的可达性；实际创建及逐块读取仍检查固定快照权限。

探测仅在明确查询时发生，不在启动时扫描网络；每节点最多配置 16 个固定 LAN peer，最多 4 个并行探测，每连接超时 2 秒。探测不带源票据，也不读取数据。不要用能力声明替代目标最终 READY 检查。

`installTransfers(service)` 提供 `service.transferCall(principal, operation, args)`，与 HTTP 和导出的 `transferCall` 共用限流与串行通道：全局最多 8 个在途／排队调用，每账号和每传输最多 2 个。I/O 不持有全局账号／调度队列，每次 RPC 前后重新核对账号策略，取消先持久写入意图以阻止迟到启动。数据库事务均是无 await 的同步操作。恢复只观察原任务，不自动重派；调用者必须固定同一重试键。

`service.transferSnapshot(ownerId, transferId)` 是不联网的只读安全回执；只返回该 owner 的记录，否则 null，不含源票据。内部训练准备适配器可保存逻辑源引用、重试键及 transferId，复用现有传输表和唯一核对定时器。copy 成功返回的 `result.dataset` 可能是新的私有数据集 ID；必须保存其映射，检查版本相等，再以真实目标 ID 查询 READY、申请数据租约，之后才允许申请 GPU。不得仅凭 `SUCCEEDED` 或客户端自报下载完成放行训练。

首次 create 回执丢失时，用 `service.transferSnapshotByKey(ownerId, clientKey)` 从同一表恢复已接受任务，不联网、不重新选择源，也不需要源节点仍在线；owner 隔离与安全字段和按 ID 查询相同。

若服务安装了纯本地 `datasetPhysicalReference(ownerId, sourceMachine, {dataset,version})`，手动 copy/download 会在固化请求摘要前使用已确认的 owner 专属物理 ID。映射不得改变版本；同一重试键的映射变化会拒绝，不会悄悄改源。

## 管理员启用 LAN 复制

先按 [部署说明](DEPLOYMENT.md) 部署本 PR 的 Portal、executor bridge 和**完整节点 runtime**；升级工具默认不启用 LAN 监听、不重启 GPUQ。旧配置和数据库保留。本机上传/下载不需要 peer 服务。下列命令从此仓库目录运行。

所有 configure 命令默认使用 `~/.local/libexec/gpuq-console`；现有安装在其他位置时，每次传入 `--program-dir /实际绝对路径`（例如 `~/.local/libexec/amax-console` 经 shell 展开后的路径）。预览会显示核验后的 `programDir`，安装的 peer unit 使用这个目录的绝对路径，不借模板猜测；目录必须由服务账号拥有且不可被其他账号写入，控制字符会拒绝。

源节点由 GPUQ 服务账号生成独立 TLS 证书/私钥，放在账号私有目录，文件权限 0600；不要复制 VPS 管理 SSH 私钥。配置文件仅含：

```bash
umask 077
openssl req -x509 -newkey rsa:3072 -nodes -keyout /私有路径/peer-key.pem -out /私有路径/peer-cert.pem -subj /CN=gpuq-lan-peer -days 365
```

```json
{
  "transferPeer": {
    "bind": "192.168.77.3", "port": 18443,
    "certificate": "/绝对私有路径/peer-cert.pem",
    "privateKey": "/绝对私有路径/peer-key.pem"
  }
}
```

```bash
# 服务账号运行；先预览
python3 deploy/configure-transfers.py --peer-config /私有路径/source.json
```

```bash
# 确认后启用的只有新 peer 服务，不是 gpuq.service
python3 deploy/configure-transfers.py --peer-config /私有路径/source.json --apply --enable-peer
```

预览输出源证书的 `certificateSha256`。目标节点配置一个明确的 LAN 地址与该摘要，并预览、`--apply`，无需 `--enable-peer`：

```json
{
  "transferPeers": {
    "gpu-1": {"address": "192.168.77.3", "port": 18443, "certificateSha256": "源节点输出的64位摘要"}
  }
}
```

```bash
# 目标节点、服务账号：target.json 权限同样为 0600
python3 deploy/configure-transfers.py --peer-config /私有路径/target.json
```

```bash
python3 deploy/configure-transfers.py --peer-config /私有路径/target.json --apply
```

双向复制就在同一 JSON 中并列 transferPeer 和 transferPeers，各自预览并启用；机器 ID 用实际 inventory ID。防火墙仅允许团队目标节点访问该 LAN 端口。接口只有固定版本的只读能力，不提供命令执行；证书变化后需管理员重新确认 pin。凭证默认随任务期限加 1 小时过期；明确 resume 时会先确认旧进程组已停，再为同一源快照续签，不自动续签，也不允许改源版本。

单节点最多 4 个活动或未确认的后台传输，CPU 2 核额度、内存 2 GiB；默认期限 24 小时，可在 copy 中用 `--timeout 秒数` 设置，最多 7 天。断网重试有上限，耗尽后保留断点，明确恢复。存储使用原上传配额、预留空间、路径和 READY 校验规则。
