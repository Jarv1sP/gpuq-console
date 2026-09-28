# 安全报告

请使用仓库 Security → Report a vulnerability 私下报告凭据泄露、越权、执行桥逃逸等安全问题；不要在公开 Issue 贴 token、私钥、生产地址或可直接利用的细节。

尚无独立安全审计。适用范围为可信实验室；不建议未经额外审计直接用于对抗性多租户、付费公共 GPU 云或存放高度敏感数据。

管理员应定期升级操作系统、OpenSSH、bubblewrap、slirp4netns、Node.js 和浏览器。root 入口属于完全信任能力，不是隔离环境。备份须另行异地保存；本仓库默认仅同机数据库备份。
