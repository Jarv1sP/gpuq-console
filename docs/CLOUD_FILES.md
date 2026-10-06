# 私人云文件

云文件是个人数据空间的可选副本，不是训练挂载盘，也不会让成员获得管理员的云盘账号。

本文保留可选功能的工程与验收说明，不代表部署已开通。成员网页 `/guide` 暂不推荐云盘或链接导入；当前数据集上传说明以校内直传为准。

## 使用

在“数据”页打开“云端副本”。输入个人 `/data2` 内的文件路径，存到云端；显示“待云端确认”时保留原件，点击“检查云端”。确认后可取回到一个新的相对路径，不覆盖已有文件。

```sh
gpuctl data cloud upload incoming/data.tar --machine SERVER
gpuctl data cloud list --machine SERVER
gpuctl data cloud verify FILE_ID --machine SERVER
gpuctl data cloud download FILE_ID restored/data.tar --machine SERVER
gpuctl data cloud status OPERATION_ID --machine SERVER
gpuctl data cloud cancel OPERATION_ID --machine SERVER
```

传输在后台继续，不需要一直开网页。先结束个人数据终端，避免传输期间文件被修改。下载中断后，用相同 `--key OPERATION_ID`、文件编号和目标路径继续，后台会重新核验前缀。上传没有盲目续传：响应丢失时先查原编号，不要换编号重复提交。

已确认的文件也可点击“重新校验”。若下载提示“文件已变化”，先重新校验对应的云端副本，再取回到新的路径；旧下载不会自动续传，已有文件和临时内容都会保留。普通连接中断仍按原下载的编号续传，不要因此另建上传。

这组命令传输的是**服务器上的个人文件**。电脑到服务器仍使用校内直传、HTTPS 下载链接或已明确确认的 VPS 中转。不能把上述功能称为浏览器直传阿里云盘，也不能据此认为任意校外电脑已绕过 VPS。

## 管理部署

一个云账号只启用一个中心节点。CD2 只在该节点运行，监听 loopback，使用专门的目录限制令牌。其余训练节点用平台已有的局域网数据传输，不另外安装 CD2、复制账号或独立计量同一份云额度。

节点的 `cloudFiles` 配置必须包含：`enabled`、`nodeExecutable`、`worker`、`privateConfig`、`maxFileBytes`、`maxUserBytes`、`maxTotalBytes`。Node.js 运行时及 JS 依赖应固定版本并独立部署，不替换系统 Node。`worker` 是本仓库的 `cloud-files-worker.mjs`。

`maxUserBytes: 0` 可关闭每个成员的云存储字节份额，但 `maxTotalBytes` 必须为正数，始终限制整个后台云账号的已预留容量；它不能设为无限。下载到节点还受该节点实际剩余空间和预留容量限制。两者均为应用计量，不是后台账号的云厂商套餐或节点文件系统硬配额。

运行 `npm ci && npm run build:cloud-worker` 生成单文件 `build/cloud-files-worker.mjs` 及 SHA256 清单。把此产物与已核验的 Node 24 放到中心节点的管理员管理目录，`worker` 指向该产物。节点不需要另行安装 npm 依赖；其余机器只安装 Python 控制器并保持功能关闭。

私有配置包含 `enabled`、`capabilityVerified`、`scopeId`、`cloud`（已核验的 CD2 云名与账号标识）、`endpoint`、`allowInsecureLoopback`、`tokenFile`、`receiptKeyFile`，可设置 `maxBytes` 和 `timeoutMs`。令牌文件采用 `{ "apiToken": "..." }`；回执密钥是独立32字节随机文件。配置、令牌、密钥均0600，父目录0700。不要将这些文件提交Git或发给成员。

节点控制器继承打开的个人文件描述符给工作进程；不接受任意宿主路径。后台先持久化全局/个人云容量预约，再发送文件。取消、失败和不确定结果都保留云端内容及容量计数，不会擅自删除网盘文件。管理员清理云端时须同步核对保留账本，不能仅因任务失败就释放计数。

确认范围：云端对象身份、大小、SHA-1和下载SHA-256；一次读取可能命中CD2缓存，不能冒充独立冷读或可靠的唯一备份。部署验收至少包含跨用户拒绝、取消、断点下载、已有文件保护和真实小文件往返；大文件性能另行实测。

CD2 的本地 `/static/` 下载接口会在查询参数中附带专用令牌。适配器仅向固定的节点回环地址发送经过账户和文件路径核验的描述符，不跟随重定向；该 URL 不进入成员响应、命令参数或日志。
