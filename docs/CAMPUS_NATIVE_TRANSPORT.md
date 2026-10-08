# CLI 校园物理接口 HTTPS

源码默认在 Linux CLI 的数据集、个人项目文件及结果下载中使用本通道。
单文件客户端构建自动内嵌两种架构；这不表示生产入口或真实业务已验收。网页没有变化。
它只给已授权校园文件连接选择物理接口；门户控制请求、普通公网代理、
Tailscale 偏好、hosts、路由和设备配置均不修改。

`native/campus-http` 是无第三方依赖的 Go helper。Linux 上从实际主路由表
IPv4 默认路由选择最低 metric 的接口，核对内核接口类型、MAC、UP、
地址和非 tun 属性。不同接口的最低 metric 相同则拒绝，不能猜网络。
仅本次 socket 使用 `SO_BINDTODEVICE`；拒绝绑定时停止，不提升权限或
退回 Tail/VPS。DNS 必须给出 RFC1918 IPv4 地址。helper 不硬编码设备名。

TLS 使用系统 CA、正常域名/SNI 和精确叶证书 DER SHA256，完成两项
验证后才写入短期票据和正文。不接受重定向、代理变量或写请求重试。
每个 helper 生命周期复用同一 HTTP/1.1 TLS 连接，避免每块重握手；
路由、接口地址、endpoint、pin、revision、machine 或原操作身份改变
立即停止。票据与字节只通过有界 stdin/stdout frame，不进 argv、环境、
日志或临时文件。stdout 的原始正文单块最多 1 MiB，错误不含服务端正文。

## 个人文件

[`client-campus-native.mjs`](../client-campus-native.mjs) 提供
`campusNativeTransportOptions()`，其 `agentFactory/send` 可传给现有
`createPersonalFileTransport`。`send` 保持 `personalFileRequest` 签名，
固定 `/v1/files/{issuedGrantId}/{get|put}`；下载保持 protocol 2、原 path、
size、fingerprint 和 offset。上传原 UUID、完整 SHA 和完成回执仍由
原调用者与节点票据 scope 核对，不新增上传身份或绕过发布保护。

原生 helper 在丢 ACK 后结束此连接。既有 journal 和只读原编号查询
仍是恢复依据；重复同一命令可沿原身份继续，不能默默重放原写请求。

## 数据集

[`client-campus-native-dataset.mjs`](../client-campus-native-dataset.mjs)
提供 `createCampusNativeDatasetTransport(requestGrant, options)` 和
`probeCampusNativeUploadRoute(route, options)`。只接受 primary
`campus-direct`，固定 `/v1/uploads/{originalUploadId}/{status|manifest|chunk}`。
status 只查已选文件的 metadata，完整会话状态、begin/seal/commit
继续走现有控制接口。不新增 admission、修改票据、切换仓库或换 UUID。

节点 grant 的 `chunkBytes` 为 1 MiB，`maxChunkBytes` 可为 1 或 16 MiB。
实现保留 grant 原值，transport 暴露 `chunkBytes: 1 MiB`。现有
[`client-data-upload.mjs`](../client-data-upload.mjs) 的
`Math.min(maximum, preferredChunk)` 因而选择合法 1 MiB 块；manifest
原来也是 1 MiB。原 offset 可不对齐，不改变 manifestSha256、文件
SHA 或 admission handle。隔离回归验证原 offset 3 的 2 MiB+37 文件
经过三块得到相同完整 SHA，不把 16 MiB 上限变成硬性块大小要求。

## 默认客户端与构建

`createPersonalFileTransport` 与 `campusDatasetTransportDefaults` 在 Linux
默认选择原生 helper；现有测试／用户注入的 factory、agent 和 send hook
仍可显式使用。macOS、Windows 保留原 HTTPS transport，不承诺物理接口
防接管。所有 CLI 上传、下载及数据集 finally 均 await transport.close，
关闭自身 child 和临时目录完成后才返回最终结果。

维护者运行 `npm run build:client` 会先构建 Linux amd64/arm64 静态 ELF，
然后通过 esbuild define 将 SHA、长度和字节嵌入 standalone gpuctl。用户
下载这一文件即可使用，不另装 Go、curl、Tail 或 helper。原始源码开发
使用 `npm run cli -- ...` 会自动预构建；`node cli.mjs ...` 使用已有
`build/campus-native/embedded-artifacts.private.json`，未构建时明确要求
先构建，不在一次文件请求中联网下载工具链。

构建使用精确 Go 1.27.1。`GO` 可指向已有相同版本；否则构建脚本查当前
同版本 Go，或在项目自己的 build/toolchains 下载 [Go 官方归档清单](https://go.dev/dl/?mode=json&include=all)
中固定架构的 archive。下载最多 100 MiB，完整 SHA 核对后才解压和执行。
缓存核对原归档身份、私有普通文件与已验证 binary SHA，再检查版本；
异常停止。Linux 与 macOS 两种架构的构建主机受支持，解压需 tar。
这只影响构建目录，不安装机器环境或改用户配置。

`deploy/Dockerfile` 的 Node 构建阶段复制相同脚本与 Go 源码，按固定
官方归档 SHA 自动重构建两架构并打包；最终镜像只保留 gpuctl artifact，
不需要运行时 Go。开发与 Docker 沿用相同入口和静态编译参数。

helper 在本人 0700 临时目录中验证嵌入 SHA、以 0700 单链接普通文件
执行。destroy 有界等待启动、退出与自身目录清理，每阶段最多 2 秒；
先向自身 child 发 SIGTERM，1 秒后仍未关闭只向同一 child 发 SIGKILL。
收到 close 后才删除自身目录并 await 完成。退出或清理不确认会报错，
不删除活进程目录、不追加任何网络写入。

## 实际范围

源码与静态构建支持 Linux x64/arm64。真实匿名物理连接仅在一个
Linux x64 普通 uid、无有效 capabilities 的环境验证；arm64 为交叉
编译，其他内核可能拒绝普通用户绑定，错误会明确停止。macOS、Windows
原生、IPv6、无主默认路由或歧义多 NIC 不在本实现支持范围。

隔离 TLS 测试覆盖完整原始字节、连接复用、证书变更/不可信拒绝在票据
之前、原 UUID/offset/SHA、丢 ACK 不重放、网络变化、大小/响应界限及
进程清理。真实匿名 capabilities 不代表正式票据传输、READY、完整业务
闭环或千兆吞吐验收；这些需由维护者整合后沿真实授权流程完成。
