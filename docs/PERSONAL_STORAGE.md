# 两类数据入口与自由工作区

这是可选的新布局，需管理员在有本地机械盘和固态盘的节点配置并验收完整运行时。没有启用时保持原目录；升级源码不会搬走旧项目、数据或任务结果。

## 用户只关心三个入口

| 路径 | 用途 |
| --- | --- |
| `/data-hdd` | 本人在这台机器上的机械盘数据草稿，可新增、解压、清洗 |
| `/data-ssd` | 本人的固态数据草稿或明确复制过来的热数据 |
| `/workspace` | 工作区，默认机械盘；目录名和组织方式由自己决定 |

这些目录不是整块宿主机硬盘。原 `/outputs`、`/data2/数据集ID` 为兼容入口，仍可使用。
已有数据集用提交中的完整 `--data ID@VERSION` 选择；发布版本挂载只读，个人草稿保持可写。不要把会修改的草稿当作可复现的固定训练输入。

启用后的**新项目**在机械盘保存代码、环境、发布版本和工作区。旧项目保持原位置；不会因配置变更迁移旧环境。

```sh
gpuctl storage info
gpuctl project create my-project
gpuctl push .
gpuctl ssh
# 在项目终端自由组织 /workspace、/data-hdd 和 /data-ssd
exit
gpuctl project publish
gpuctl project status
```

## 训练与输出

独立工作区默认使用本次发布代码的机械盘可写副本；原发布快照不变。续跑不会重新覆盖工作副本或 checkpoint。
大项目在后台准备工作副本，完成前显示排队原因且不申请 GPU；准备失败或结果未知不会自动重跑。取消原任务也会阻止稍后派发。

```sh
gpuctl run --workspace-mode isolated -g 1 -- python train.py
gpuctl run --workspace-mode shared -g 1 -- python train.py
```

`shared` 明确共享**同账号、同项目、同发布版本**的工作副本和结果。多个任务能互相覆盖，需自己选择不同输出子目录；不同版本不自动覆盖旧工作区。旧布局项目拒绝该选项，不悄悄放开只读代码。

程序可读取 `/data-hdd/my-data` 或 `/data-ssd/my-data`，把结果写到 `/workspace/自己选择的目录`。`GPUQ_OUTPUT_DIR` 在新训练布局中为 `/workspace`，旧项目仍为 `/outputs`。旧任务的结果下载路径不变；新任务用 `gpuctl pull --job JOB_ID 相对路径 本地路径` 下载工作区文件。

新工作副本允许修改代码，不能再声称执行期间代码始终只读；需要复现时保存自己对副本的改动。机械盘随机读取、频繁保存大型 checkpoint 可能变慢。容器引擎及控制数据仍在原平台盘，不能声称完全不占 SSD。

本版先支持手选同机，不支持该布局的自动选机或自动复制私人目录。旧项目原有的自动选机保持不变；不要通过省略选项让新布局悄悄降级为旧目录。

## 显式复制与发布数据

以下复制在**同一服务器**后台运行，不申请 GPU；关闭电脑不停止已受理的复制。只复制目录到新目标，不移动或覆盖。目标父目录先在自己的终端创建。

```sh
gpuctl storage copy samples hot-samples --from hdd --to ssd
gpuctl storage copies
gpuctl storage copy-status COPY_UUID
gpuctl storage copy-cancel COPY_UUID
gpuctl storage copy-resume COPY_UUID
```

命令派发前会打印原 UUID；建议保存，或主动指定 `--key UUID`。响应不明先查原编号，不换新编号；忘记编号可用 `gpuctl storage copies` 找回。只有确认旧 worker 停止的 `FAILED` 可恢复；`UNKNOWN` 找管理员核对。取消不可恢复，来源和已复制的私人临时字节保留，不能视为已完成的数据。断点由平台管理，不在可见数据目录中，不能手工修改。完成表示当时内容通过 SHA256 校验，不保证后来没有被自己修改。

处理完数据后结束占用这两个个人数据区的终端／任务，再发布本地固定版本。检查来源无写入者，发布期间不允许新写入者进入。

```sh
gpuctl storage publish samples --tier hdd --name my-data
gpuctl storage publish-status PUBLICATION_UUID --tier hdd
```

机械盘发布生成 `h-…` 数据集 ID，固态发布生成 `s-…`；使用返回的完整 ID 和版本，不从中文显示名拼路径。发布复制与校验发生在选定的同一类盘，不经过电脑、不强制复制到 SSD。原草稿保留，后续修改要另行发布新版本。

用发布返回的完整 ID 和 64 位版本替换下面的 `DATASET_ID@VERSION`：

```sh
gpuctl run --workspace-mode isolated -g 1 --data DATASET_ID@VERSION -- python train.py --data /data2/DATASET_ID --output /workspace/my-exp
```

`--` 后的参数由自己的程序解析。发布前须结束本人正在占用个人数据区的开发终端和任务；后台会检查持久读取／写入保护，未确认停止时拒绝，不靠关网页解除。无需结束其他用户的任务。

未启用的节点、挂载缺失、权限或空间不足会拒绝，不伪装成零用量、无限空间或自动改盘。这些入口不自动跨机分发私人目录，也不自动清理 SSD、归档结果或提供独立备份。
