# 固定版本目录预览

这是源码候选契约，不是节点部署回执。目录读取不等于文件正文查看、下载、训练准备或复制授权。

## 公共 API

已认证 `POST /api/call`：

```json
{"operation":"datasets.files.list","args":{"dataset":"sample","version":"FULL_IMMUTABLE_SHA256","path":""}}
```

`dataset` 为目录逻辑 ID；`version` 必须 64 位小写十六进制，不接受 latest。`path` 可省略，
表示根目录，仅安全相对目录，UTF-8 不超过 4096 字节；可选 `cursor` 必须是原页返回值。
不能传 machine、owner、userId、hostAdmin、force 或宿主路径。Portal 重新核对当前启用
账号内容 ACL，再选已确认 READY 的固定原件或副本，优先仓库原件。管理员目录可见性
不代表读取别人文件的授权；零额度账号仍需原有精确仓库源授权，不获得训练机器访问。

成功：

```json
{"protocol":"dataset-files-list-v1","available":true,"dataset":"sample","version":"FULL_IMMUTABLE_SHA256","path":"","entries":[{"name":"images","path":"images","type":"directory","bytes":null},{"name":"labels.txt","path":"labels.txt","type":"file","bytes":42}],"nextCursor":null}
```

每页最多 200 条且完整响应不超过 64 KiB；只返回登记清单中的直接子目录和普通文件，
不递归扫全树，不返回源路径、owner ID、票据、原始清单或正文。`bytes` 为固定文件逻辑
大小，目录 null，不冒充分配块数。`entries:[]` 只能来自实际成功读取的空目录。

下一页使用原 `nextCursor`，保持同一账号、版本、目录及实际源机器／登记引用。节点还
绑定 owner metadata、注册和 READY stat 身份；来源变化或失联时拒绝，不换源续页。
节点先验 member ACL，再取得 GC／租约准入使用的版本锁，锁覆盖整页读取；metadata
页不创建持久下载租约。逐条 no-follow 验证普通单链接文件和目录，拒绝 symlink、硬链接、
越界路径和变化中的发布数据。注册清单自身仍遵守既有 64 MiB／500000 项上限。

旧／未知节点明确返回：

```json
{"protocol":"dataset-files-list-v1","available":false,"dataset":"sample","version":"FULL_IMMUTABLE_SHA256","path":"","reason":"DATASET_FILES_NODE_UNAVAILABLE"}
```

没有 `entries`，不是空目录。无内容 ACL 为 403；未确认固定源为
503／`DATASET_FILES_SOURCE_UNCONFIRMED`；响应丢失为 503／`DATASET_FILES_UNCONFIRMED`，
不重放或换源；非法／过大节点响应为 502。读取走已有最多 4 个并发的数据读取 lane，
维护期间可查，不进入串行写队列。调用前后均重新核验会话及账号。

`datasets.overview.filePreviewAvailable` 仅在本账号存在已确认 READY 源且该源节点新鲜
容量明确 `datasetFileList:1` 时 true，逐数据集仍独立验权。`fileContentPreviewAvailable:false`：
本次没有正文预览 API。

## 独立节点安装边界

私有节点操作增加 trusted `userId,hostAdmin:false`；物理登记名由 Portal 决定。新
`datasets.capacity` 返回 `datasetFileList:1`。旧节点不回退裸文件 API。通用桥只新增
literal `datasets.files.list`，不是通配读或 host.exec。新的
`node-executor.py --dataset-files-rpc` forced path 仅接受固定的
`datasets.list / datasets.capacity / datasets.files.list`，拒绝终端流、上传、删除、prepare
和额外 envelope 字段，不修改既有 upload-only key。

节点最小源码 overlay 为 `node-executor.py`、`dataset-cache.py`、`dataset-files.py`、
`storage-observation.py`、`node-runtime.json`。仍须完整 immutable runtime closure，
特别是 `project-store.py`、`platform-root-guard.py` 及仓库／租约／删除保护模块；原配置
只能复制已核实版本，不改旧 runtime、原 reader、config 或 migration pin。新 forced key
与桥固定路由由部署负责人设置，客户端不能选择 key、flag 或版本目录。

迁移中的节点不得原位覆盖：用独立版本目录并 fresh capture/CAS 证明旧 runtime/config
和 protected units 未变。现存独立 upload-only runtime 不自动放行 metadata 操作。
真实节点能力回执前保留 unavailable；本地 fixture、Portal 合并都不证明 5090 或所有
节点已能预览，生产须另验已授权原件的真实目录页。

## 定向验收

```sh
node --test tests/dataset-files.test.js tests/dataset-files-http.test.js tests/dataset-storage-overview.test.js
python3.12 tests/dataset-files.test.py
python3.12 tests/storage-project-observation.test.py
```

覆盖跨账号／管理员负例、零额度、旧节点、分页、撤权、链接和身份变化、整页版本锁、
只读 forced path、未知采样与 inode 去重。不建生产测试数据集、不改变迁移保护。
