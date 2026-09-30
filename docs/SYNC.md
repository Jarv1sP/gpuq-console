# 半自动同步

先选择来源、目标和模式，使用 `--dry-run` 预览；去掉它才写入目标。不会自动选机器、改环境或删除文件。传输经门户与既有节点桥中转，适合代码和中等数据，不是 TB 数据的高速内网通道。

## 从 Git 导入代码

需要支持 `check-attr --source` 的本地 Git，不支持该检查的版本会明确拒绝同步，不需要 tar。仓库必须干净（包含未跟踪文件）。固定分支、tag 或 commit；按该 commit 的原始 blob、UTF-8 路径与可执行位同步全部普通文件，不做 checkout/archive 换行、编码或 filter 转换，不受 Windows `core.autocrlf` 影响。不上传 `.git`、符号链接、submodule、Conda/venv；Git LFS 指针不会自动下载实体。Git filters 和 fsmonitor 命令在同步子进程中禁用；若工作树只有通过本地 filter 转换才与 commit 一致，请使用未经 filter 转换的干净 clone。

为避免意外上传原本会被归档排除的内容，固定 commit 中对文件或目录生效的 `export-ignore` / `export-subst` 规则会直接拒绝同步（不会静默忽略规则或转换 blob）；请准备明确选择文件、无这些归档转换规则的同步 commit。仓库本地 `info/attributes` 覆盖也会拒绝，建议使用无本地属性覆盖的干净 clone。检查只读取固定 commit，不使用当前工作树、系统或全局 attributes 改变它；命令不修改用户 Git 配置。

```sh
gpuctl sync git ./my-repo --ref HEAD --to gpu-2 --project vision --dry-run
gpuctl sync git ./my-repo --ref HEAD --to gpu-2 --project vision
```

只创建新的项目草稿；已有普通项目不会覆盖。相同来源、目标和清单生成同一重试键，重复原命令可续传。首次打印的 key 也可用 `--key UUID` 固定。Git ref 变化或脏工作树会拒绝完成。

## 从节点复制已发布代码

```sh
gpuctl sync code --from gpu-1 --to gpu-2 --project vision --release 完整64位源版本 --target-project vision --dry-run
```

去掉 `--dry-run` 执行。复制固定 release 的代码，不复制之后改过的草稿、项目环境或任务输出。来源和目标都必须是授权节点；目标项目名必须未使用，或属于同一项可续传同步。

两种代码同步结束都只表示 `CODE_READY`，还不能训练。环境必须在目标节点准备并发布：

```sh
gpuctl use gpu-2
gpuctl project use vision
gpuctl ssh                # 准备项目自己的隔离环境；完成后 exit
gpuctl project publish
gpuctl project status     # 等 READY，记录目标节点的完整 release
```

节点环境不同，目标 release 可以与来源不同；提交训练固定使用目标 READY release，不替换成 latest。代码未传完时，目标项目不能开开发终端、普通上传或发布；重复原同步命令完成后解锁。任务已经运行的旧项目不受影响。

## 复制普通数据

来源必须已 READY。使用现有个人数据集上传/校验流程，部分传输可以续传；最终内容版本必须等于来源。

```sh
gpuctl sync data 源数据集名称@完整64位版本 --from gpu-1 --to gpu-2 --name samples --dry-run
gpuctl sync data 源数据集名称@完整64位版本 --from gpu-1 --to gpu-2 --name samples
```

结果打印目标完整 `名称@版本`，训练用该引用。目标沿用个人命名空间：同一账号用同一 `--name` 复制自己的数据集，标识保持一致；共享来源转为个人副本时名称可能改变，但内容版本不变。目标已有的其他版本、目标独有文件不会被删除。

中断后重复同一命令，不要把请求超时当作已取消。数据上传开始校验后，即使客户端断开，节点校验继续；用输出的 uploadId 执行 `gpuctl data upload-status ID --machine gpu-2` 查看。已明确放弃的上传须用新的 `--key UUID` 重新开始。同步不申请 GPU，也不自动迁移 Conda 或隐藏依赖。

## 部署与回退

本候选明确依赖 #5 的统一 `deploy/node-runtime.json` 部署清单和 #6 的正常单文件 CLI 构建。清单新增 `snapshot-sync.py`，保留 `data-workspace.py` 和匹配的项目/数据依赖；安装器与两个升级器按同一清单处理。VPS `execution-worker.py` 须允许新 snapshot/sync RPC，Portal 镜像包含 `snapshot-sync.mjs`，客户端由 esbuild 的真实 import 图构建。先升级节点与执行桥，再发布门户及客户端，不能只复制单个执行器文件。

维护者按已有节点安装/升级流程备份配置、项目与状态目录后手动发布；无需迁移 GPUQ schema。回退不删除项目、数据、同步清单或未完成上传。存在未完成代码同步时应先完成或由维护者处理其明确项目范围，不能通过回退旧 `project-ops.py` 绕过同步锁。
