# 开源依赖与出处

本仓库原创门户、CLI、执行桥和 GPUQ 采用 MIT；第三方项目保留各自版权与许可证，不因集成而变成本项目原创。下列链接指向上游；升级时须重新核对许可证和兼容性。

| 项目 | 用途 / 分发方式 | 许可证与来源 |
|---|---|---|
| xterm.js 6.0.0 / addon-fit 0.11.0 | 浏览器终端；JS/CSS 及原许可证放在 `dist/vendor` | [MIT](https://github.com/xtermjs/xterm.js/blob/master/LICENSE) |
| Playwright | 开发与 CI 的双浏览器流程验收，不随生产容器安装 | [Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) |
| esbuild 0.28.2 | 构建单文件 CLI，编译共享模块的实际依赖；仅开发与 Docker 构建阶段安装 | [MIT](https://github.com/evanw/esbuild/blob/main/LICENSE.md) |
| Node.js | Web/API/CLI 运行时；Docker 基于 Node 24 | [MIT 及所含组件声明](https://github.com/nodejs/node/blob/main/LICENSE) |
| Python | GPUQ 与节点桥运行时，不随源码复制解释器 | [PSF 等](https://docs.python.org/3/license.html) |
| SQLite | Node 内置数据库后端 | [Public domain](https://www.sqlite.org/copyright.html) |
| Tailscale | VPS 到节点的管理网络；独立安装，不含客户端二进制 | [BSD-3-Clause](https://github.com/tailscale/tailscale/blob/main/LICENSE) |
| Headscale | 可选自建 Tail 控制面；示例固定 0.29.3 | [BSD-3-Clause](https://github.com/juanfont/headscale/blob/main/LICENSE) |
| OpenSSH | 主机指纹校验、受限密钥与强制命令 | [多项 BSD 类许可证](https://www.openssh.com/openssh/portable.html) |
| Caddy | HTTPS 反向代理、证书续期；示例镜像 2.10.2 | [Apache-2.0](https://github.com/caddyserver/caddy/blob/master/LICENSE) |
| bubblewrap | Linux 用户/挂载/进程/设备隔离；系统依赖 | [LGPL-2.1](https://github.com/containers/bubblewrap/blob/main/LICENSE) |
| slirp4netns | 普通工作区的用户态网络；系统依赖 | [GPL-2.0](https://github.com/rootless-containers/slirp4netns/blob/master/COPYING) |
| systemd | 作业生命周期与 cgroup 资源约束；系统依赖 | [上游许可说明](https://github.com/systemd/systemd/blob/main/LICENSES/README.md) |
| Docker / Compose | 可选 VPS 容器部署；不分发 Docker Desktop | [Moby Apache-2.0](https://github.com/moby/moby/blob/master/LICENSE)、[Compose Apache-2.0](https://github.com/docker/compose/blob/main/LICENSE) |
| HAMi-core | GPUQ 的可选显存共享后端，仅保留适配代码；不含其二进制 | [Apache-2.0](https://github.com/Project-HAMi/HAMi-core/blob/master/LICENSE) |

新增服务端二维码依赖 [node-qrcode 1.5.4](https://github.com/soldair/node-qrcode)（MIT）；二维码在本机生成，不调用第三方二维码服务。

阿里云盘分享导入的接口兼容性参考 [OpenList 的 AliyunDrive Share 驱动](https://github.com/OpenListTeam/OpenList/tree/main/drivers/aliyundrive_share)，扫码登录流程参考 [itxve/aliyundriver-refresh-token](https://github.com/itxve/aliyundriver-refresh-token)（MIT，Copyright 2022 itxve）。本仓库独立实现客户端，不打包 OpenList，不复用其账号或令牌服务。连接的是阿里云盘官方 HTTPS 端点；网页接口变动可能需要更新适配，会员权益以提供方实际支持为准。

GPUQ 源码从本实验室原有、包含源码的 Python zipapp 整理而来，保留原功能模块；不是引用同名 GitHub 项目，也不声称其旧高级功能都已完成门户级授权集成。构建仅打包仓库里的 `.py` 文件。

训练框架由部署者另外安装，例如 [PyTorch](https://github.com/pytorch/pytorch/blob/main/LICENSE)；可选 [Miniforge](https://github.com/conda-forge/miniforge/blob/main/LICENSE) 作为 Python 环境。NVIDIA 驱动、CUDA 及其他模型/数据遵循其各自条款，不在此 MIT 许可范围内，不随本仓库分发。安装 Anaconda 等发行版时也须自行确认其适用许可。

GitHub Actions 使用上游 checkout、setup-node、setup-python，仅用于测试，不连接生产网络。依赖版本以 `package-lock.json`、Compose 与 Dockerfile 为准。
