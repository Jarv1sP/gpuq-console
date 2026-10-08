# 可选的展示读取执行桥

Portal 可通过 `EXECUTOR_DISPLAY_SOCKET` 使用独立的展示读取 socket。
未配置时保留现有 `EXECUTOR_SOCKET` 的行为。
本变更不启用配置、不替换正式桥、不部署节点。

只有以下已认证展示请求可选择新桥：

- `datasets.overview/catalog/capacity/list/files.list`
- `files.list`
- `storage.usage.mine/users`

在这些请求内部，仅 `datasets.list`、`datasets.capacity`、
`datasets.files.list`、`files.list` 四个节点操作可走展示桥。
账号、服务器、版本、路径及读取权限仍由原逻辑核对。
写请求及其依赖读取、任务状态、终端、上传、下载正文和缓存操作走原桥。
展示桥报错时不自动回退或重放请求；按原接口返回失败或未知。
观察缓存沿用原 TTL 与真实采集时间，切换账号仍重新按当前权限投影。

启用需后端确认 socket 对应运行时、支持的操作和当前授权。
配置与部署由发布负责人执行；节点无配套能力时不宣称展示已恢复。
验收在原上传场景分别检查容量、目录、真实成员权限和写操作路径；
本地夹具及一次成功采样不证明上传期间所有窗口都无阻塞。
