# P0 冻结发布候选

本目录从 `c6a392a` 独立导出，合入冻结终端会话、诊断补丁和指定 Ray 运行时文件。不是当前主工作树的全量复制。这里的说明和本地测试不代表已部署。

## 两种安装档位

| 档位 | 安装方式 | 边界 |
| --- | --- | --- |
| 公共 P0（默认） | `--runtime-profile common-p0` | 新终端独立会话、单写租约、显式重连/接管，以及训练诊断采集；沿用原 runner 资源设置，不新增 CPU 委派检查 |
| 完整 Ray P0（可选） | `--runtime-profile ray-p0` | 公共能力，加真实 cgroup 资源读回、只读预算、Ray 适配器；替换前必须通过内核 CPU/内存/PID 探针 |

安装器仍需原有 inventory、node 和两把公钥参数。公共档使用 `deploy/sandbox-runner-common-p0.py`，目标文件名仍为 `sandbox-runner.py`；完整档使用 `deploy/sandbox-runner.py`。两份是本次冻结发布 overlay，不在主工作树维护长期双分支。已有完整 Ray 节点再次安装时必须显式选 `ray-p0`，否则会选择公共档。

`--configure-cpu-delegation` 仅能与 `--runtime-profile ray-p0` 一起显式使用，且仍需独立批准管理员变更；安装器不会刷新或重启活跃用户管理器。公共档不会改 CPU 委派，也不会读回、承诺原有 CPUQuota 已被内核执行。两档均不改 GPUQ 数据库或升级 schema，已有 scheduler 保持 schema 9。

终端/诊断查询前后端本身不依赖新 runner。若仅更新这些组件而保留旧 runner，终端隔离可用，但旧任务和未带采集 hooks 的新任务只返回实际已有 scheduler 历史，持久日志/计数明确显示 `UNAVAILABLE`。要启用新训练的采集，使用公共档 runner 即可，不需要完整 Ray 档。正在运行的任务和终端不会因替换文件自动重启；已有 PTY 不主动断开。

公共档采集器的 CPU 10% 是原 systemd 限额请求：未委派 CPU 的节点不能承诺已执行这一 CPU 上限；采样频率、并发数、内存/PID 上限仍保留。终端不启动诊断采集器。两档都必须安装/启用诊断 GC service/timer，终止确认后的原始 runtime 清理由其完成。

## 不在本批

优先级与 schema 10、管理员非交互执行、隔离 venv/offline assets、网络辅助工具和项目发布进度改动均未合入。原来显式启用的 ROOT PTY 能力仍保持其权限边界；不增加 sudoers 授权。没有安装任何管理员非交互命令入口。

手动发布时先逐文件核对本批 manifest。不要把当前主工作树整体同步到节点；不要在未批准 CPU 变更的节点安装完整 Ray runner。选择档位是发布者按节点的决定，安装器不会改 node-config 来隐式启用资源预算。

## 验证与交接

本地运行 Node 全套、Python 全套、桌面/移动端终端项目流程、诊断窗口/JSON 下载流程；GPU、真实 Linux cgroup 和生产 systemd 不在本地测试覆盖内。手动八卡 payload 不加入自动测试，不在宿主执行。

配套 `runtime-p0-manifest.json` 列出相对基线的每个文件及 SHA-256；`runtime-p0-evidence/` 保存测试结果。源代码包排除本地依赖链接、缓存、截图和任何配置凭据。仅供审核/发布，由主线程另行验收和部署。
