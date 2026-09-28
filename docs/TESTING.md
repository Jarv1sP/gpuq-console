# 测试与发布检查

## 每个 PR 的离线自动测试

```sh
npm ci --ignore-scripts
npm test
npm run test:python
npx playwright install --with-deps chromium
node tests/ui-smoke.mjs
python3 scripts/build-gpuq.py
python3 build/gpuq.pyz --help
python3 -m compileall -q deploy gpuq scripts
python3 scripts/check-public-tree.py
docker build -f deploy/Dockerfile -t amax-console:test .
```

覆盖账号/中文名、密码和会话、邀请码、角色、乐观授权写入、并发配额、幂等提交、超时保留、所有权、root 拒绝、API/CLI、上传越界/软链接、部署清单验证。不访问生产节点、不使用真实账号密码，不因 PR 启动真实训练。

浏览器测试启动临时本地后台和独立数据库，验证注册自动登录、初始零额度、管理员自动发现待处理用户、授权后用户自动更新、编辑草稿不被刷新覆盖、注册码再次可读、引导 admin 退役与移动端布局。不会连接真实执行桥或 GPU；可选 `CHROME_PATH` 使用本地 Chrome，`UI_SCREENSHOTS` 指定私有截图目录。

## 上线前的实机验收

1. 用普通邀请码注册；未获批前提交和终端应拒绝，不能自选 admin。
2. 批准一台机器两张卡、总额两张；未批准机器拒绝，第三张拒绝。
3. CLI 登录、选择机器，进入个人终端建 venv/安装一个小包、写文件。
4. 上传最小 CUDA 程序，申请单卡；确认文件与环境相同，不能打开其他 GPU。
5. 申请同机双卡，使用 torchrun/NCCL all-reduce 检查多卡通信；核查结果下载。
6. 启动一个可取消作业，等待 RUNNING 后取消；检查后代进程消失、卡数释放。
7. 用第二个普通账号尝试读取/取消第一人的任务、读其文件、开 root：均拒绝。
8. 将测试用户升为管理员；验证每台已启用节点的 root `id -u` 为 0，结束终端。再降级应撤销旧登录、拒绝 root。
9. 重启仅门户服务，确认已有训练继续、幂等重试不新增任务、配额恢复。模拟桥超时须保持 UNKNOWN/预留而非重新派单。
10. 退出 API/CLI；旧 token 拒绝；确认临时 GPU 作业和终端都结束。

不要拿忙碌服务器做驱动/内核破坏测试。测试目录与正式实验分开，不删除别人的数据。完整裸机部署、不同驱动和网络拓扑都需在部署者环境中重复验证，现有部署通过不代表所有组合都通过。

## 2026-09-29 已有部署验收范围

已在真实账号上完成普通注册→零权限→审批→CLI→个人终端/环境→单卡 CUDA→双卡 NCCL→下载→运行中取消→管理员→四台主机 root→退出。测试工作负载结束。公开仓库不包含此部署的账号、地址、任务日志、数据库或结果文件。

账号与界面收尾包含 33 项 Node 测试、10 项 Python 测试和上述双浏览器流程。正式站另外核验个人管理员登录、当前注册码保持不变且可读、旧 admin 删除、工作台/管理页分离，以及从正式站下载的 CLI 登录、选机和退出。

源码通用化另用自动测试和隔离容器检查；不将“文档已写好”描述为“在每一种空白机器上部署过”。
