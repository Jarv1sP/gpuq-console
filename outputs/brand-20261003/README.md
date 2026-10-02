# VELA · 本地视觉验收

2026-10-03。本目录是原生 HTML/CSS/SVG 的品牌提案与本地浏览器预览，不是生产部署回执。界面数据为合成测试数据，没有真实用户资料、节点操作或训练任务。

## 设计预览

- [三个名字与 VELA 字型对照](vela-aster-apex.png)
- [VELA PRECISE · 定制几何](vela-precise.png)（本次选择）
- [VELA AIR · 轻字重](vela-air.png)
- [VELA FORWARD · 微前倾](vela-forward.png)
- [可编辑提案源文件](brand-studies.html)

产品采用双帆 V 与克制定制字标、深蓝灰侧栏、暖白页面。中文导航与常用操作位置保留；数据准备状态的细微动画响应 `prefers-reduced-motion`。不使用商业航天标识，没有做商标可用性检索。仓库、域名、CLI、服务器身份与权限不随展示名变化。

## 实际界面

- [工作台 · 桌面](ui/workspace-desktop.png) / [手机](ui/workspace-mobile.png)
- [算力总览 · 桌面](ui/resources-desktop.png) / [手机](ui/resources-390.png)
- [数据集 · 桌面](ui/datasets-desktop.png) / [手机](ui/datasets-mobile.png)
- [指南 · 桌面](guide/guide-index-desktop.png) / [手机](guide/guide-index-mobile.png)

## 验证范围

本地 Chrome、Loopback 合成服务。19 组 UI smoke 已通过；portal、指南与 dataset UI 相关 27 个单元测试通过。响应式检查覆盖 320、390、768、820、900、1024 与 1440px；检查了唯一当前导航、键盘跳转、草稿保留、减少动态效果及选定说明文字的计算对比度不低于 4.5:1。对比度检查针对计算出的纯色表面，不等于完整 WCAG 认证。

不据此声称实际云盘、LAN 副本或生产服务器已验收；这些由独立数据层验收负责。
