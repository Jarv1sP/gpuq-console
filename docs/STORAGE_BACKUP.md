# 独立磁盘备份

训练缓存和长期原件都不等于备份。另备一份放在**不同物理磁盘**上；同机第二块盘可以防单盘损坏，但不能覆盖整机损毁、失窃或机房事故。更高要求应再保留离机副本。

`deploy/storage-backup.py` 是可选的 Linux / restic 运行助手，**不会随节点升级自动启用**。它不格式化磁盘、不初始化仓库、不删除快照、不恢复文件，也不会停止训练。它只接受固定的本机仓库和来源，核对主机名、文件系统 UUID、实际挂载、剩余容量后运行备份或完整校验。

## 部署前确认

- 备份盘与来源盘确实是不同物理磁盘；不同分区、bind mount、同一 RAID 卷上的两个目录不算独立备份。
- 固定备份盘的 UUID 挂载，未挂载时的底层目录设为 root 所有、不可供普通用户写入。不要让备份静默落到系统盘。
- 使用受维护发行版提供的 restic。本助手已用 Ubuntu 22.04 的 restic 0.12.1 完成真实 backup / check / restore 验证；升级后重跑恢复验收。
- 仓库、状态目录、口令及配置目录均为 root 私有；口令另存在独立的私密备忘或密码库。只把口令放在被备份的服务器上不够。
- 列出需要保护的实际目录。备份助手拒绝来源下的额外挂载；不要把 NFS、其他磁盘或临时 bind 不加区分地递归纳入。

## 配置

默认读取 `/etc/gpuq-backup/config.json`。下面只是结构示例，主机名、UUID、路径和容量均须替换；不要直接覆盖已有配置。

```json
{
  "schema": 1,
  "host": "compute-01",
  "repository": "/backup/gpuq-restic",
  "passwordFile": "/etc/gpuq-backup/password",
  "stateDirectory": "/backup/gpuq-backup-state",
  "mounts": {
    "/data": { "uuid": "DATA_FILESYSTEM_UUID", "fstype": "ext4" },
    "/backup": { "uuid": "BACKUP_FILESYSTEM_UUID", "fstype": "ext4" }
  },
  "sources": ["/data/platform", "/data/datasets"],
  "reserveBytes": 214748364800,
  "reserveInodes": 100000
}
```

`mounts` 必须覆盖所有来源、仓库和状态目录所在的真实文件系统。来源可以是普通目录或文件，但不能是整机 `/`、符号链接或未经固定的额外挂载。配置所写 UUID 对应实际挂载点本身；不会以父目录“看起来存在”代替挂载验证。

建议权限：配置目录、仓库根、状态目录和备份挂载点 `root:root 0700`；配置、口令 `root:root 0600`；脚本 `root:root 0755`。首次创建仓库由管理员显式执行 `restic init`，确认口令已有独立留存后再启用定时任务。不要把口令放进命令参数、环境变量、仓库或公开日志。

## 运行与定时

将脚本安装为 `/usr/local/libexec/gpuq-storage-backup.py` 后，可运行：

```sh
sudo python3 -B /usr/local/libexec/gpuq-storage-backup.py backup
sudo python3 -B /usr/local/libexec/gpuq-storage-backup.py check-all
```

第二条会读取并校验整个仓库，首次备份之后应执行；它不是快速健康检查。两者共用状态目录的排他锁，不能同时运行。应将它们交给独立 systemd oneshot 服务执行，设置所需挂载、低 IO 优先级、CPU/内存上限、足够的超时及 `KillMode=control-group`。备份可按每日低负载时段启动，首次大备份可能持续数小时。

不要随意给服务增加私有挂载命名空间；其继承的旧 NFS 挂载可能阻碍后续维护卸载。实际需要的隔离与挂载布局应一起测试。

通过前置检查并获得排他锁后，操作在 `stateDirectory` 留下独立 JSON 回执与日志，`latest.json` 指向最近一次已进入执行阶段的状态。成功为 `BACKUP_COMPLETE` 或 `FULL_DATA_CHECK_PASSED`。配置、挂载、容量或锁前检失败时，不会冒险写入状态盘，必须查看 systemd 的本次执行时间、`Result`、`ExecMainStatus` 与 journal；不能把旧的成功回执当成本次成功。`RUNNING` 也只表示曾启动，须结合 systemd/PID 判断是否仍运行，断电或强制终止后尤其如此。

容量不足、挂载不符、来源缺失或 restic 返回不完整/失败时拒绝报告成功。助手不自动清理旧快照；维护者应监控容量，按恢复要求确定保留期，在核对快照和完成恢复演练后再显式执行 restic 的保留/清理操作。

## 恢复验收

1. 查看仓库快照，选定明确的快照 ID，不凭目录存在判断备份完成。
2. 完整校验仓库。
3. 把选定的小文件恢复到一个新的、私有的临时目录；核对内容 SHA256、权限和必要的链接/xattr。不要覆盖生产文件做测试。
4. 记录恢复结果及口令保管位置，不把口令写进验收报告。

这是**文件级备份**，不是跨文件的应用事务快照。维护停机时的首次备份仍需核对服务已静默；日常在线备份可能跨越数据库/清单的多个版本。门户数据库应继续使用其 SQLite 在线备份流程。恢复节点登记、租约、任务或上传状态时，须结合对应元数据和身份重绑定流程审查，不能直接恢复旧目录并开启调度。恢复文件到新盘后，原 inode/设备身份也不能原样视为有效。

项目输出、模型和数据是否受保护取决于实际配置的 `sources`；一台机器安装了备份不代表全体节点或所有个人目录已备份。
