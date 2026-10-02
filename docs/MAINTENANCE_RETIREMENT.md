# 维护申请已停用

普通用户不再提交待审批的 root 脚本。缺少系统依赖时，在协作区说明机器、软件用途与报错，由管理员处理。管理员已有的独立 ROOT 终端、`gpuctl exec`、命令状态和取消功能不变。

## 升级行为

- `maintenance.create/preview/approve/return/withdraw/cancel` 和其他非读取的 `maintenance.*` 调用返回 HTTP **410 Gone**。旧客户端、旧预览 token、重复审批都不能执行脚本。
- `maintenance.list` / `maintenance.get` 保留原有身份和机器访问检查，用于历史查询。管理员可以查看所有历史记录；普通成员只能查看自己在仍获授权机器上的记录。
- 旧数据库表、脚本、结果和审计不删除。`PENDING` 保留原始状态，但明确标为不可操作，不自动批准、撤销或改写历史。
- 对已经派发的操作，只用原机器、原执行键、原审批身份查询 `host.status`；不会重跑、取消或接管。未知结果仍为 UNKNOWN，不能视为未执行。
- 网页主导航不再显示申请入口；旧 `#maintenance` 书签显示只读历史页。CLI 只保留 `gpuctl maintenance list` / `show ID`。

这次变更不修改 GPU 调度器、GPU 任务或节点 ROOT 权限。部署前保留数据库备份；不要为回退界面而恢复旧数据库。旧版本会重新开放审批，因此不应直接回退到包含可执行维护申请的旧门户。

## 个人终端的实际边界

目前个人工作区使用 bubblewrap 的文件系统、进程、网络和设备隔离；不是完整的 OCI 容器镜像。系统 `/usr` 和基础 Conda 只读，用户可以在个人项目环境安装 Python 包，但不能通过 `sudo apt` 修改系统。日常终端不挂载 GPU；训练由 GPUQ 分配设备。管理员的宿主 ROOT 终端是另一条明确的运维入口，不能和个人终端混为一谈。

## 验收

`tests/maintenance-api.test.js` 检查旧接口封禁、历史/审计保留、原任务仅查询、跨账号/机器权限、输出边界和独立管理员 exec；`tests/maintenance-http-cli.test.js` 通过真实本地 HTTP 和独立 CLI 验证旧客户端不能绕过；`tests/maintenance-ui-smoke.mjs` 检查浏览器历史页、无提交/审批控件、文本安全及手机布局。
