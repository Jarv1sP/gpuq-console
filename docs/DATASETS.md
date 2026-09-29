# 固定版本数据集：先准备，再训练

本页描述仓库中的数据集接口与部署步骤，不代表某台服务器已经完成配置。普通用户以所选机器返回的授权目录和 `READY` 为准；源码测试通过不能替代真实节点的挂载、只读和断网验收。

## 用户最短流程

先手选机器，并在该机创建/选择项目。数据集准备与代码/环境发布是两件事：

```sh
gpuctl use gpu-1
gpuctl project use my-project
gpuctl data list
gpuctl data prepare NAME@VERSION
gpuctl data status NAME@VERSION
```

把 `NAME@VERSION` 整段替换为目录里显示的名称与**完整 64 位小写十六进制版本**，不是 `latest`、短哈希或宿主机路径。项目须已完成上传代码、安装依赖、发布；完整新建流程见 [项目手册](PROJECTS.md)。数据及需要的项目版本均为 `READY` 后：

```sh
gpuctl run -g 1 --data NAME@VERSION -- python train.py --data /data2/NAME --output /outputs
```

`--` 前的 `--data` 是平台的数据集选择，后面的 `--data /data2/NAME` 是示例训练程序参数；如果你的程序使用其他参数名，应按程序修改。当前客户端使用 `-g 1`，不要合写成 `-g1`。

数据准备运行在节点后台，不申请 GPU，不占训练用卡额度；关闭网页或客户端不会把准备任务变成训练。只准备完数据还不够：所选节点的项目代码与私人 venv 也要发布 READY；代码/环境发布不等于数据本地就绪。平台没有实现项目、环境或代码的自动跨机分发。

训练读取的是所选节点的本地副本，挂载为 `/data2/NAME`，只能读。项目训练输出、缓存索引和模型写 `/outputs`，代码 `/workspace` 与项目环境只读，不能写回数据集。未迁移的旧个人工作区任务仍按旧方式写 `/workspace`。普通无 GPU 终端不会自动挂载训练的数据集。

多个数据集可重复写 `--data NAME@VERSION`，门户每个任务最多接受 8 个；同一次任务不能挂载同一名称的两个版本。新提交不再接受 `run auto`：只核验用户手选机器上的全部数据及项目版本，未就绪就拒绝且不占卡，不换到别的节点；GPU 数量由所选节点自动分配。历史任务仍保留，但不会据此重新进行自动选机。

## 网页流程

1. 打开左侧“数据集”，选择已获授权服务器，再加载目录。
2. 找到固定版本，点击“准备到本机”；稍后刷新，并在必要时用 `gpuctl data status NAME@VERSION` 查看后台结果。
3. 显示“本机已就绪”后，点击“用于训练”，检查工作台里的机器与固定版本。
4. 选择同一机器的 READY 项目版本，填写训练命令，例如 `python train.py --data /data2/NAME --output /outputs`，再提交；程序参数按实际代码调整。

“用于训练”只是填入训练表单，不代表已申请 GPU 或已开始任务。换机器后应重新核对该机器的版本状态。机器授权与数据集所有者授权分别检查；能看机器资源不等于能读取它的全部数据。

管理员可以查看和维护所有数据集，但以个人身份提交训练时也必须列入该版本的 `owners`。管理可见不等于个人训练已获授权；管理员应先在可信管理入口明确授予自己的数据读取权限。

## 状态意味着什么

| 状态 | 可以训练吗 | 含义与处理 |
|---|---|---|
| `REGISTERED` | 否 | 已登记固定清单，尚无可用本地副本；请求准备 |
| `REGISTERING` | 否 | 管理员后台正在生成清单；目录扫描可能耗时 |
| `PREPARING` | 否 | 节点后台准备任务仍在执行 |
| `STAGING` | 否 | 存在未发布副本；可能正在传输，也可能是中断后待续传，不能单凭它断言任务仍活着 |
| `READY` | 是，仍需配额及调度许可 | 本地完整清单与文件 SHA256 验证通过，已经原子发布 |
| `FAILED` | 否 | 后台准备失败；查看错误，修复容量、源可达性或授权后重试 |
| 无法读取／忙／未知 | 否 | 没有确认就绪；不要当作空数据集或成功 |

目录状态与后台准备任务状态不是同一个对象。后台失败不会把半份文件标为 `READY`。遇到一直“准备中”、失败后网页无法重试或状态不刷新，先用 `data status` 查结果，再联系管理员；不要通过修改目录、伪造 `READY` 标记或提前运行训练绕过校验。

## 存储布局与旧数据

所有节点的新缓存统一使用 `/data2/datasets`；`/data2` 必须是明确的、可写的本地数据文件系统挂载，不能只是系统盘上的同名目录。缺失、只读、被替换或变成系统盘时拒绝操作。

```text
/data2/datasets/                   缓存服务持有，0700
  .registry/                      授权与内容清单，不向普通用户暴露源路径
  .staging/NAME/VERSION/           未就绪版本与续传围栏
  ready/NAME/VERSION/data/         校验后的本地只读内容
  .leases/                        持久作业租约
  .locks/                         全局短锁与逐版本锁
  .trash/                         已安全移出目录、等待清理的对象
```

作业内的 `/data2/NAME` 只映射 `ready/NAME/VERSION/data`，不会映射整个宿主机 `/data2`、注册目录或所有数据集。

旧 TB 级目录保留原位置、原数据与原所有权，不会因为部署、注册或改用统一入口就被自动搬走、删除或批量复制。管理员应只登记明确批准的数据集范围；**登记不等于本机 `READY`**。首次准备某个版本时，才按需复制到该节点缓存；已有本地版本可重复使用。

`register_source` 为生成内容版本会读取所登记范围内的全部文件并计算哈希。它不是零开销的路径登记，更不应对整块旧数据盘自动运行。先用小样本验收，再由管理员安排实际数据集的登记窗口。源内容变更应登记新版本，不能覆盖已有版本。

## 管理员：本地目录与可信配置

以下均为宿主机管理员操作，不是普通 `gpuctl` 用户接口。命令在已检查的节点上显式执行；文档本身不会创建目录、挂载网络盘或重启服务。

先只读预览 `/data2`，再准备服务私有缓存目录：

```sh
sudo python3 deploy/prepare-data-root.py --service-user CACHE_SERVICE_USER
sudo python3 deploy/prepare-data-root.py --service-user CACHE_SERVICE_USER --apply
```

`CACHE_SERVICE_USER` 必须是实际执行缓存操作的服务账号。若 `/data2` 由已确认的非 root 管理员 UID 持有，只有经过核实才添加 `--trusted-parent-uid UID`；不能借此信任普通用户。工具只创建缺失的 `/data2/datasets`，不递归 `chown` 或修复已有目录。已有权限不匹配时停止并人工核查。

若还没有合格的 `/data2` 挂载，应先按 [部署手册](DEPLOYMENT.md) 与 `deploy/storage-layout.py --help` 预览存储映射。不得用创建一个空 `/data2` 目录来掩盖数据盘未挂载。

独立管理 CLI 从 root 所有、仅 root 可读的配置文件读取来源，例如 `/etc/gpuq/datasets.json`：

```json
{
  "root": "/data2/datasets",
  "serviceUid": 1000,
  "serviceGid": 1000,
  "reserveBytes": 10737418240,
  "sources": {
    "tiny-local": "/data2/imports/tiny"
  }
}
```

这里只是格式示例。UID/GID、源路径与账号必须按节点核实；配置文件应 root-owned、mode `0600`。CLI 先核验配置，再按 `serviceUid/serviceGid` 降权；服务账号必须有源的读取权限。普通用户不能提交或修改这份配置，也不能把任意宿主机路径转换为来源。

节点执行器使用节点私有配置中的 `datasets` 对象，格式略有不同：

```json
{
  "datasets": {
    "root": "/data2/datasets",
    "mountPoint": "/data2",
    "reserveBytes": 10737418240,
    "sources": {
      "tiny-local": "/data2/imports/tiny"
    }
  }
}
```

节点执行器已以服务账号运行，这个对象不接受 `serviceUid/serviceGid`。管理 CLI 与执行器必须使用一致的缓存根、来源编号和实际来源映射；只在 CLI 配置里加入来源，并不会自动更新节点执行器的配置。

### 已有执行节点增量升级

已安装执行器且完成数据盘准备时，可将本版本的部署文件暂存到节点，使用原服务用户预览后更新，不必重新安装 GPUQ：

```sh
python3 deploy/upgrade-datasets.py --directory ~/.local/libexec/gpuq-console
python3 deploy/upgrade-datasets.py --directory ~/.local/libexec/gpuq-console --apply
```

`--directory` 必须改为实际执行器目录。工具备份原配置与程序，保留工作区、调度数据库、网络助手及个人环境路径，不重启 GPUQ、不覆盖终端助手。早期配置缺少 `conda` 时只从旧 runner 的固定只读挂载提取原路径；缺少 `hostRoot` 时仅已识别旧版本可自动保留既有管理员能力，未知版本必须先人工审核并显式配置，不能借升级自动授予 root。

## 管理员：登记与准备小样本

先确认 `/data2/imports/tiny` 是专用小样本，而不是整个旧 TB 数据目录。`owners` 填平台不可变用户 ID，不能填显示名、Unix UID 或共享服务器用户名；可通过管理员的 `gpuctl users --json` 查找。下面的 `demo-user-1` 是示例，必须替换为实际获准用户。

```sh
sudo python3 deploy/dataset-cache.py --config /etc/gpuq/datasets.json <<'JSON'
{"op":"register_source","dataset":"tiny","sourceId":"tiny-local","owners":["demo-user-1"]}
JSON
```

成功输出 `{"ok":true,"result":{...}}`，其中 `version` 是完整内容哈希。CLI 只读取 JSON 中的固定操作，不执行用户提供的 shell/rsync 命令。注册不会自动复制源。之后可由已授权用户运行 `gpuctl data prepare tiny@VERSION`，或管理员在本机调用：

```sh
sudo python3 deploy/dataset-cache.py --config /etc/gpuq/datasets.json <<'JSON'
{"op":"materialize","dataset":"tiny","version":"替换为注册结果的完整64位版本"}
JSON
```

这个占位字符串必须替换，不能原样执行。独立 CLI 的 `materialize` 会同步等待复制与校验；门户的 `datasets.prepare` 由节点后台任务执行，及时返回操作编号。

来源必须是明确批准的独立目录。拒绝宽泛系统/家目录、穿越、软链接、特殊文件和多硬链接文件；凭据与环境目录不属于数据集。版本内容只包含清单列出的文件和目录，后来新增的源文件不会混入旧版本。

数据集与来源编号使用 1–64 位 ASCII 字母、数字、下划线或连字符，并以字母或数字开头；这不限制平台用户使用中文显示名。当前单份清单最多 500,000 个文件与目录条目，清单/元数据 JSON 上限仍为 64 MiB；两个上限均须满足。超过时需要管理员按合理范围分组，不能承诺任意规模目录都能一次登记。节点数据集后台任务单独限 2 GiB 主存、1 核 CPU 额度；这不改变训练、终端或其他服务的额度，也不保证任意文件名长度/目录形状都能装入上限。

## 管理员：清缓存与注销登记

`evict` 只清理指定版本的本地 READY/staging 副本，保留登记以便重新准备。`unregister` 在清理目标副本后移出登记，支持单版本或整个数据集；**两者都不删除、不改写批准的原始来源，也不停止训练**。只允许管理员操作，机器仍须明确选择。名称必须是目录中的数据集 ID，不能传宿主机路径、来源路径或 `force`。

```sh
gpuctl use gpu-1
gpuctl data unregister NAME@FULL_VERSION_HASH
gpuctl data unregister NAME
gpuctl data status OPERATION_ID
```

上面两条注销命令是两种范围的示例，应按需选择一条：带完整版本只注销该版本；裸名称注销该机该数据集的全部登记版本与残留副本，不影响其他机器、其他数据集或其他版本的数据授权。提交返回 `UNREGISTERING` 和 64 位 `operationId`，表示**已受理、尚未完成**；不会在短请求内同步等待大副本删除。用返回的真实编号查询，只有后台收据 `UNREGISTERED` 才确认该次操作结束；`unregistered:false` 表示目标登记已不存在。收据是历史操作结果，之后重新登记应另查 `data list`。

`FAILED` 表示后台失败；`UNKNOWN` 或网络超时表示结果未确认，不代表 worker 已停止。客户端不会自动重投或取消。保留操作编号，先查询原操作；若提交响应丢失，管理员应先核对节点执行器工作区的 `dataset-ops/` 操作记录及缓存 `.trash/unregister-*/REMOVAL.json`，不能因超时就声称已删除或盲目重复操作。查明失败原因后才能重试；新的显式注销请求会产生新的操作编号。后台操作状态查询不允许普通用户读取注销收据。

任一目标版本存在作业租约、租约损坏或准备/发布持有版本锁时，注销失败关闭，不释放租约、不杀训练。整集操作先检查全部目标，再开始移动；清理阶段继续持有逐版本锁，完成前再次核对登记，避免覆盖并发新增版本或所有者修改。可信外部 rsync 不由本接口停止：管理员必须先确认所有外部写入者已退出并关闭文件。作为 LAN/NFS 发布源时，还须先确认其他节点不再复制该源；跨节点来源读取当前没有自动租约，不能只看本机训练租约便认定可清理。

清理失败时保留登记与恢复日志，可能已有本地副本被安全隔离；不能把“登记仍在”当成 READY。成功后，恢复包位于缓存根下 `.trash/unregister-<编号>/`，包含 `REMOVAL.json` 和 `registration/`。整集保留完整登记目录；单版本保留其原始版本 JSON 及 `dataset.json` 所有者快照。恢复包不是原数据备份，已清理的副本须从原始来源重新准备。不要自动覆盖后来新增的登记/授权；恢复前先比对恢复包与当前目录。

不经过门户时，管理员也可在节点使用下面的 root-only CLI；它同步等待结束，大规模清理可能很久，不应套用执行桥的短超时。配置仍须 root-owned、0600，操作按配置降至缓存服务账号执行。

```sh
sudo python3 deploy/dataset-cache.py --config /etc/gpuq/datasets.json <<'JSON'
{"op":"unregister","dataset":"tiny","version":"替换为完整64位小写版本"}
JSON
```

整集注销省略 `version` 或显式设为 `null`。该入口只处理所选缓存根，不能代替清理其他机器、修改来源配置或删除原始数据。

## 已有可信清单与跨节点来源

跨节点复用时，由管理员从已登记源导出 `export_manifest` 的 `result.manifest`，通过可信管理通路在目标节点调用 `register_manifest`，明确该节点上的 `owners`。导入只接受结构化文件清单，不接受来源 hostpath；目标重算内容版本，必须与来源的完整版本一致。

目标节点已有管理员批准的只读来源时，用 `attach_source` 绑定它，不重新扫描整棵网络源：

```sh
sudo python3 deploy/dataset-cache.py --config /etc/gpuq/datasets.json <<'JSON'
{"op":"attach_source","dataset":"tiny","version":"替换为完整64位版本","sourceId":"tiny-lan"}
JSON
```

`tiny-lan` 必须预先存在于可信 `sources` 映射。普通用户不能调用绑定接口，配置外的来源编号会被拒绝。`attach_source` 并不证明网络内容正确；准备只读取清单指定的文件，对续传前缀与单文件变化做检查，最终在本地全树 SHA256 验证通过才发布。它不在网络源上反复做 TB 级全量哈希。

当前复制库也提供 `plan`、1 MiB 有界 `put_chunk`、已发布版本的 `read_chunk` 和 `publish`。断点计划包含已写偏移与前缀 SHA256；重试不能覆盖不同内容。管理员限定的 `prepare_transfer` 可返回 staging 目标供可信传输器使用，但它**不会自行启动 rsync，也不是给普通用户的任意目标传输服务**。任何外部写入者必须退出并关闭文件后，才能调用 `publish`。

## LAN / NFS 只做来源，不做训练盘

采用千兆硬件时，优先让已批准节点通过内网读取只读来源，按需准备本地副本。训练阶段不持续从远端读数据，也不会把普通用户电脑上传的大数据绕经 VPS 当作高速分发。

`deploy/dataset-nfs.py` 的管理模型是：源节点只发布固定的 `/data2/datasets/ready`，目标节点只读挂到 `/data2/library`。这是一个固定源节点的来源挂载，不是多源发现、任意 NFS 导出或自动选择共享服务器。相应来源路径为 `/data2/library/NAME/VERSION/data`，没有额外节点名层级。

在源节点预览、核实后显式应用；`PEER_RFC1918_IP` 是获准复制节点的真实私网 IPv4，可重复 `--peer` 列出多个节点，不能原样使用占位符：

```sh
sudo python3 deploy/dataset-nfs.py server --peer PEER_RFC1918_IP --service-user CACHE_SERVICE_USER
sudo python3 deploy/dataset-nfs.py server --peer PEER_RFC1918_IP --service-user CACHE_SERVICE_USER --apply
```

在复制节点预览、核实后应用，`SOURCE_RFC1918_IP` 为该固定源节点的真实私网 IPv4：

```sh
sudo python3 deploy/dataset-nfs.py client --server SOURCE_RFC1918_IP
sudo python3 deploy/dataset-nfs.py client --server SOURCE_RFC1918_IP --apply
```

按实际父目录所有者核实后，必要时才添加 `--trusted-parent-uid UID`。工具使用专用 `/etc/exports.d/gpuq-datasets.exports` 和 `/etc/systemd/system/data2-library.mount`；拒绝接管其他有效导出、竞争的 NFSv4 根、不同内容的同名配置或被覆盖的非空客户端目录。服务器来源为只读、`root_squash`；客户端固定 NFSv4.2/TCP、只读并设置 `nosuid,nodev,noexec`，不修改服务器全局协议选项。

这些命令需要实际节点具备 NFS 依赖与经管理员批准的内网访问条件；预览和本地测试不能证明线上 NFS 已安装、已导出或已挂载。普通用户的 `data prepare` 不能安装 NFS、修改导出、建立挂载或开放端口。

服务器与客户端缓存服务的 UID/GID 必须一致。`root_squash` 下客户端 root 访问私有目录被拒绝并不意味着源故障，应以缓存服务身份验收。不要为方便访问而把整个缓存目录放宽为公共可写。NFS 主机级来源信任不替代平台逐用户数据授权；限定私网 peer，禁止面向公网开放。

来源挂载使用 `hard`：源服务器失联时，正在复制的内核读取可能等待恢复，网页或后台任务超时不等于读取会立即终止。已经准备好的训练只读本机副本，不依赖来源持续在线。当前没有跨节点的来源租约，管理员不得在其他节点正在复制时清理发布源版本；若源缺失或变化，接收端会拒绝发布 `READY`，但本次准备仍可能失败。

当前工具没有自动卸载或整体回滚子命令。需要停用来源时，先禁止新的相关准备并确认正在读取该源的后台任务已经结束；再人工停止/禁用**该专用** `data2-library.mount`，核对挂载已卸载后才移除对应的受管 unit 文件。忙挂载不应强制或懒卸载。服务器侧逐一撤销确切的 `peer:/data2/datasets/ready` 导出，例如管理员核实后使用 `exportfs -u PEER_RFC1918_IP:/data2/datasets/ready`，再处理专用配置；不要运行全局 `exportfs -ua` 或用 `exportfs -ra` 代替定向回滚。

回滚来源配置不删除 `/data2/library` 下的源数据、不删除 `ready` 内容或租约，也不停止已经只读使用本地副本的训练。不要在仍挂载 NFS 时对挂载目录递归清理；旧 GPUQ/Slurm 调度切换是另一项需排空节点的维护，不属于 NFS 回滚。

## 安全、容量与恢复

- 缓存根、注册清单和租约由缓存服务私有持有；普通请求只引用名称、版本、已登记的相对文件名，不能指定 hostpath、来源主机、Unix 身份或外部命令。
- 清单完整校验、只读数据与同文件系统的原子无覆盖发布共同构成 `READY`。staging 中残留的 `READY.json` 不是已发布版本。
- 默认保留 10 GiB 空间，并计算未完成传输的保守空间预留；空间不足时拒绝继续，不覆盖已有字节或把半份数据发布。
- 作业在使用数据前取得持久租约。租约不因重启或时间流逝自动失效；只在可信执行层确认作业及其子进程都结束后释放。`UNKNOWN` 不等于可以清理。
- `evict` 仅限管理员，没有任何租约时才可清理本地版本；保留注册清单以便以后重新准备。它不是原始数据删除器，也没有后台按年龄自动清缓存。
- 数据损坏、坏元数据、失联、挂载不明、校验错误或锁忙都失败关闭。不要删除 lease、补写 READY 或把只读源改成可写来“修好”状态。
- 缓存目录的只读 mode 不是对服务账号/root 的不可变存储保证；真正对训练进程的只读边界由执行器的只读挂载实施。共享管理账号、root 和来源维护者仍属于高信任主体。

管理员可用独立 CLI 的 `verify` 做完整本地校验，用 `status` 做不扫描数据内容的状态查询。`release_lease` 是可信调度维护接口，不是普通用户的“解锁”按钮。中断传输通常保留 staging 可续传；若围栏损坏，保留现场并核查，再决定是否管理员清理该未就绪副本。

## 不同阶段，不要混为一谈

| 组件 | 负责什么 | 不代表什么 |
|---|---|---|
| 数据集缓存与门户/CLI 接口 | 固定版本、授权、准备、校验、本地只读挂载、租约 | 自动同步代码/项目/环境，或自动迁移旧 TB 数据 |
| 项目工作区与发布接口 | 同机独立草稿、私人 venv、固定代码/环境版本、每任务输出 | 完整基础镜像、自动跨机发布、checkpoint 自动备份 |
| 管理员配置的只读 LAN/NFS 来源 | 让节点从内网复制已批准版本 | NFS 直接承担训练 I/O，或普通用户获得 NFS/宿主机管理权限 |
| 当前 GPUQ 执行链 | 用户选服务器、该节点排队与整卡分配、沙箱训练 | 自动换服务器，或已经切换为 Slurm |
| `deploy/slurm_backend.py` 与 Pyxis/Enroot 方案 | 已有测试覆盖的适配基础与后续迁移设计 | Slurm/Pyxis/Enroot 已上线、旧高级功能全部兼容或两套调度同时抢卡 |

Slurm 源码适配尚未接入生产执行器。后续仍需逐节点排空、身份与 UID/GID 映射、调度/环境验收和可回滚切换；不能因为源码或数据缓存已就绪就宣称迁移完成。

## 本地验收与节点上线门槛

```sh
python3 tests/dataset-cache.test.py
python3 tests/prepare-data-root.test.py
```

本地测试不连接真实设备。节点上线仍必须用小样本验证：授权与未授权两种身份、断点续传、错误哈希不发布、可用空间不足、`/data2` 挂载缺失、进程内只读挂载、运行中租约禁止清理，以及取消/完成后确认子进程已退出再释放租约。跨节点另验只读来源、服务 UID/GID、来源断开时失败关闭；既有本地 `READY` 副本应不依赖原网络源持续在线。
