# 编码代理入口

先读 [docs/DESIGN.md](docs/DESIGN.md)、[docs/BACKEND_API_HANDOFF.md](docs/BACKEND_API_HANDOFF.md)和对应功能文档。维护现有行为、接口与权限，从代码取事实，不按旧设计稿猜字段。

- 只改任务范围，保护未提交改动和他人分支；变基只机械整合，不丢功能。
- 仓库公开，dist/machines.js保持示例。不提交真实清单、地址/主机指纹、凭据、数据库、用户数据或生产截图；长ID只用未提交的本地清单。
- 不修改.github/workflows，常规贡献凭据没有workflow权限。沿用仓库本地git身份，不改全局身份。
- 不删除、不放宽断言；契约明确变更时改为更严格断言并在PR说明。新功能测试成功、失败、未确认、丢回执、跨账号和零授权。
- 每屏解释最多两行，其余进ⓘ/指南，普通话；未知不当成功。丢回执先查原编号，不换key自动重发；终端不重放；直传失败不自动中转。
- 服务器ID来自清单/目录，长ID缩放或省略并提示完整值。可见品牌STARGATE，历史内部名与基础设施标识不顺手改名。
- 保留组件、操作与恢复入口，遵守减少动态、键盘焦点、手机触控目标；不以隐藏内容或裁图过几何。

## 环境与验证

Node24、完整Git≥2.43（git check-attr --source）、Python3.12（tomllib）。Python从真实安装路径启动，不把解释器复制或单独链接到不同前缀；混用venv --copies曾导致encodings缺失。

按 [CONTRIBUTING.md](CONTRIBUTING.md)与 [docs/TESTING.md](docs/TESTING.md)安装依赖，跑npm test、npm run test:python、全部浏览器smoke、相关构建及git diff --check。UI用原生截图与共享测量器验证1440/390/320、角色/异常状态；文档改动核对引用与全量Node。记录确切提交、既有skip、首轮失败与实际重跑范围，不把旧结果冒称新提交通过。

## PR 与部署

从最新main建独立分支，开PR前机械变基并检查工作树。描述写最终范围、行为、测试、截图或文档核对结果与未测范围。维护者明确批准才合并；已给出的具体授权和条件沿用，不重复询问。

部署经维护者批准，仅按 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)“仅更新Portal前端”。验收确切候选和当前生产内容，部署互斥、保留回退、只换门户；门户批准不包含节点服务、存储脚本或基础设施部署。私有部署通路留在维护者私有记录，不写公开文档。
