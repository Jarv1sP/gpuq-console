# 单机容量的展示回退

`datasets.capacity {machine}` 在已授权机器的旧字段之外，只对明确的
`dataset-storage-node-v1` 追加安全的 `storageOverview` 展示投影：
`cache.volume/budgetBytes/projectBytes/projectUsageComplete/projectCollectedAt`
与 `warehouse.state/volume`。卷保留节点采集时间和独立角色，仓库不借用训练盘容量。
私有 owner/project 拆分、路径和凭据不透传；旧节点不补造协议或角色。
`datasetFileList:1` 仅转出明确能力，目录授权仍由原接口逐次验证。

总览中的 `caches[].readyContentBytes` 在本机目录可读时，保留已确认 READY
条目的字节合计。其他条目 UNKNOWN 或缺少大小时 `usageComplete:false`，
界面沿用「≥ X」；目录不可读、所有 READY 条目均缺大小或合计溢出则为 null。
未确认容器占用仍为 null，不能用磁盘 usedBytes、缓存大小或 0 代替。

本变更只显示已读取的元数据，不改变缓存准入、复制、删除、租约或权限。
