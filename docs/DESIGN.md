# STARGATE 界面设计与代码参考

本页记录现有实现，供小维护、设计调整与编码代理使用。代码提取基线为 `34d07a1`，并同步仓库列表、直传、数据集提示、折叠控件与间距的维护；已包含导航合并、数据库与缓存、管理员删除与最后副本保护、持久保留确认与数量右对齐。历史 `starbase` 文件名和常量保留，品牌仍为 STARGATE。图形、许可与免责声明见 [BRAND.md](BRAND.md)，接口语义以 [BACKEND_API_HANDOFF.md](BACKEND_API_HANDOFF.md) 为准。

## 1. 原则

- SpaceX 控制室感来自真实对象、精确线条、巨型读数和全屏聚焦，不把操作改成航天术语。
- Apple 的克制来自明度、字级、留白和稳定位置，不添加装饰渐变、发光、霓虹或虚构扫描线。
- 功能先行：详情可以折叠，操作、原始指标、权限和恢复入口必须保留。
- 每屏一个焦点：工作台当前训练、算力服务器肖像、数据仓库列表与详情、协作区公告和帖子。
- 未知、失联、过期、未授权、确认为零是不同事实；未知不能画成空闲或释放额度。
- 真实状态先于画面完整性；缺字段就省略读数或显示待确认。
- 文案减法：显示短事实与操作，解释进入 ⓘ 或指南。

共享基座是 [starbase.css](../dist/starbase.css)，实际覆盖在 [shell.css](../dist/shell.css) 与各房间 CSS。后面的同作用域规则仍参与层叠，不能把早期共享样例当成最终应用行为。

## 2. 令牌、字体与布局

Carbon 用于工作空间，Porcelain 用于阅读；`.sb` 与 `.sb.light` 定义共享主题，指南另有局部覆盖。旧 styles 的基础变量由外壳重映射，新增组件使用当前主题变量。

[fonts.css](../dist/fonts.css) 同源托管 Archivo、Geist、Geist Mono 的可变 WOFF2。Archivo 300 承担对象标题与大数字，Geist 承担界面，Geist Mono 承担 ID、命令、时刻与版本；汉字使用系统字体。`.num` 或显式 `font-variant-numeric:tabular-nums` 保持数字对齐；数量与文件数都设置，避免 `font` 简写重置。

字标保留9753×711的原图比例，顶栏mask、小尺寸与登录SVG是不同适配。独立Λ门图标见 [favicon.svg](../dist/favicon.svg)、[favicon.ico](../dist/favicon.ico)、[mask-icon.svg](../dist/mask-icon.svg)、[apple-touch-icon.png](../dist/apple-touch-icon.png)。[index.html](../dist/index.html)的图标链接带stargate-2版本号；修改资产时同步版本与真实ico入口，避免浏览器继续用旧缓存。

下表记录共享主题与各组件的已声明自定义属性。同名多行是实际作用域/断点/后续覆盖，不能任选配色。间距和圆角没有另一套隐含令牌：没有变量的 gap、padding、border-radius 以相邻组件 CSS 为准。品牌遮罩完整载荷留在源码，不复制 SVG 路径到新组件。

| 变量 | 实际值 | 源码作用域 | 用途 |
| --- | --- | --- | --- |
| `--community-gap` | `clamp(16px,4cqi,48px)` | [community.css](../dist/community.css) · `.sb #page-community` | 协作区随容器宽度调整的区块间距 |
| `--community-inset` | `clamp(20px,2.5cqi,28px)` | [community.css](../dist/community.css) · `.sb #page-community .community-feed-focus` | 协作聚焦区的内容边距 |
| `--community-inset` | `0px` | [community.css](../dist/community.css) · `.sb #page-community .community-feed-focus` | 协作聚焦区在窄屏的内容边距 |
| `--dataset-version-help-width` | `44px` | [dataset-flow.css](../dist/dataset-flow.css) · `#page-datasets .dataset-details-cell` | 版本说明控件保留宽度 |
| `--d-bg` | `var(--bg,#f5f5f3)` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 数据集页面底色映射 |
| `--d-surface` | `var(--surface,#fff)` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 数据集表面映射 |
| `--d-line` | `var(--line,#dfdfdd)` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 数据集边界映射 |
| `--d-ink` | `var(--ink,#19191b)` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 数据集主文字映射 |
| `--d-meta` | `var(--muted,#626266)` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 数据集次级文字映射 |
| `--d-muted` | `#65656c` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 数据集弱文字映射 |
| `--run` | `#24714c` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 运行状态 |
| `--prep` | `#256083` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 数据准备状态 |
| `--err` | `#b73b3b` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 失败状态 |
| `--queue` | `#80601a` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 排队/等待状态 |
| `--v3-fetch` | `#6CB4FF` | [dataset-warehouse.css](../dist/dataset-warehouse.css) · `.warehouse-v3,.v3-upload` | 取回中的空心缓存标记 |
| `--v3-warn` | `#E8B04B` | [dataset-warehouse.css](../dist/dataset-warehouse.css) · `.warehouse-v3,.v3-upload` | 存入中、未存入或待确认 |
| `--v3-run` | `#3DD68C` | [dataset-warehouse.css](../dist/dataset-warehouse.css) · `.warehouse-v3,.v3-upload` | 当前所选服务器圆点 |
| `--v3-bad` | `#FF6B6B` | [dataset-warehouse.css](../dist/dataset-warehouse.css) · `.warehouse-v3,.v3-upload` | 已确认失败的菱形标记 |
| `--primary` | `var(--accent,#202023)` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 主操作底色 |
| `--on-primary` | `#fff` | [datasets.css](../dist/datasets.css) · `#page-datasets,#page-transfers` | 主操作文字 |
| `--d-bg` | `var(--bg)` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 数据集页面底色映射 |
| `--d-surface` | `var(--bg-1)` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 数据集表面映射 |
| `--d-line` | `var(--line-2)` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 数据集边界映射 |
| `--d-ink` | `var(--ink)` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 数据集主文字映射 |
| `--d-meta` | `var(--ink-2)` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 数据集次级文字映射 |
| `--d-muted` | `var(--ink-2)` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 数据集弱文字映射 |
| `--run` | `inherit` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 运行状态 |
| `--prep` | `inherit` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 数据准备状态 |
| `--err` | `inherit` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 失败状态 |
| `--queue` | `inherit` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 排队/等待状态 |
| `--primary` | `inherit` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 主操作底色 |
| `--on-primary` | `inherit` | [datasets.css](../dist/datasets.css) · `.sb #page-datasets,.sb #page-transfers` | 主操作文字 |
| `--dataset-block-gap` | `12px` | [datasets.css](../dist/datasets.css) · `#page-datasets` | 云端同级区块与折叠后间距 |
| `--sans` | `Geist,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif` | [guide.css](../dist/guide.css) · `@charset "UTF-8";  :root` | 界面字体栈 |
| `--display` | `Archivo,var(--sans)` | [guide.css](../dist/guide.css) · `@charset "UTF-8";  :root` | 对象标题与主读数字体 |
| `--mono` | `"Geist Mono",ui-monospace,SFMono-Regular,Consolas,monospace` | [guide.css](../dist/guide.css) · `@charset "UTF-8";  :root` | ID、命令与时刻字体 |
| `--ink` | `#242529` | [guide.css](../dist/guide.css) · `@charset "UTF-8";  :root` | 主文字 |
| `--muted` | `#606167` | [guide.css](../dist/guide.css) · `@charset "UTF-8";  :root` | 旧组件/指南弱文字 |
| `--line` | `#d9d9d6` | [guide.css](../dist/guide.css) · `@charset "UTF-8";  :root` | 基础细线 |
| `--paper` | `#f5f5f3` | [guide.css](../dist/guide.css) · `@charset "UTF-8";  :root` | 指南主纸面 |
| `--wash` | `#eaeae7` | [guide.css](../dist/guide.css) · `@charset "UTF-8";  :root` | 指南弱纸面 |
| `--accent` | `#242529` | [guide.css](../dist/guide.css) · `@charset "UTF-8";  :root` | 旧组件强调色 |
| `--guide-gutter` | `clamp(16px,4vw,48px)` | [guide.css](../dist/guide.css) · `:root` | 指南页边距 |
| `--guide-gap` | `clamp(16px,3vw,48px)` | [guide.css](../dist/guide.css) · `:root` | 指南列间距 |
| `--surface` | `var(--bg-1)` | [shell.css](../dist/shell.css) · `.sb` | 旧组件表面 |
| `--border` | `var(--line)` | [shell.css](../dist/shell.css) · `.sb` | 旧组件边界 |
| `--sans` | `Geist,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif` | [shell.css](../dist/shell.css) · `.sb` | 界面字体栈 |
| `--display` | `Archivo,"PingFang SC","Microsoft YaHei",sans-serif` | [shell.css](../dist/shell.css) · `.sb` | 对象标题与主读数字体 |
| `--muted` | `var(--ink-3)` | [shell.css](../dist/shell.css) · `.sb` | 旧组件/指南弱文字 |
| `--accent` | `var(--ink)` | [shell.css](../dist/shell.css) · `.sb` | 旧组件强调色 |
| `--blue-soft` | `var(--bg-2)` | [shell.css](../dist/shell.css) · `.sb` | 旧基础配色，应用有覆盖 |
| `--navy` | `var(--bg-1)` | [shell.css](../dist/shell.css) · `.sb` | 旧基础配色，应用有覆盖 |
| `--radius` | `8px` | [shell.css](../dist/shell.css) · `.sb` | 旧基础组件圆角 |
| `--gutter` | `20px` | [shell.css](../dist/shell.css) · `.sb` | 页面边距 |
| `--content` | `100%` | [shell.css](../dist/shell.css) · `.sb` | 内容最大宽度 |
| `--gutter` | `clamp(16px,4vw,48px)` | [shell.css](../dist/shell.css) · `.sb:not(.m)` | 页面边距 |
| `--content` | `1280px` | [shell.css](../dist/shell.css) · `.sb:not(.m)` | 内容最大宽度 |
| `--topbar-height` | `60px` | [shell.css](../dist/shell.css) · `.sb:not(.m)` | 外壳顶栏高度 |
| `--topbar-height` | `104px` | [shell.css](../dist/shell.css) · `.sb:not(.m)` | 外壳顶栏高度 |
| `--sans` | `"Geist","Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif` | [starbase.css](../dist/starbase.css) · `.sb` | 界面字体栈 |
| `--display` | `"Archivo","Noto Sans SC","PingFang SC",sans-serif` | [starbase.css](../dist/starbase.css) · `.sb` | 对象标题与主读数字体 |
| `--mono` | `"Geist Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace` | [starbase.css](../dist/starbase.css) · `.sb` | ID、命令与时刻字体 |
| `--bg` | `#0A0B0D` | [starbase.css](../dist/starbase.css) · `.sb` | 页面底色 |
| `--bg-1` | `#111215` | [starbase.css](../dist/starbase.css) · `.sb` | 一级表面 |
| `--bg-2` | `#16171B` | [starbase.css](../dist/starbase.css) · `.sb` | 二级表面 |
| `--bg-3` | `#1E2024` | [starbase.css](../dist/starbase.css) · `.sb` | 三级/悬停表面 |
| `--bg-4` | `#26282D` | [starbase.css](../dist/starbase.css) · `.sb` | 轨道或最高表面 |
| `--line` | `#212328` | [starbase.css](../dist/starbase.css) · `.sb` | 基础细线 |
| `--line-2` | `#2D2F35` | [starbase.css](../dist/starbase.css) · `.sb` | 强调边界 |
| `--line-3` | `#3B3E45` | [starbase.css](../dist/starbase.css) · `.sb` | 强边界/轨道 |
| `--ink` | `#F2F2EF` | [starbase.css](../dist/starbase.css) · `.sb` | 主文字 |
| `--ink-2` | `#A6A8AE` | [starbase.css](../dist/starbase.css) · `.sb` | 次级文字 |
| `--ink-3` | `#878990` | [starbase.css](../dist/starbase.css) · `.sb` | 元信息 |
| `--ink-4` | `#66686F` | [starbase.css](../dist/starbase.css) · `.sb` | 非文本标记/大字号弱标记 |
| `--run` | `#3DD68C` | [starbase.css](../dist/starbase.css) · `.sb` | 运行状态 |
| `--queue` | `#F2B13C` | [starbase.css](../dist/starbase.css) · `.sb` | 排队/等待状态 |
| `--prep` | `#5BB8F5` | [starbase.css](../dist/starbase.css) · `.sb` | 数据准备状态 |
| `--err` | `#FF6161` | [starbase.css](../dist/starbase.css) · `.sb` | 失败状态 |
| `--run-bg` | `rgba(61,214,140,.09)` | [starbase.css](../dist/starbase.css) · `.sb` | 运行弱背景 |
| `--queue-bg` | `rgba(242,177,60,.09)` | [starbase.css](../dist/starbase.css) · `.sb` | 等待弱背景 |
| `--prep-bg` | `rgba(91,184,245,.09)` | [starbase.css](../dist/starbase.css) · `.sb` | 准备弱背景 |
| `--err-bg` | `rgba(255,97,97,.08)` | [starbase.css](../dist/starbase.css) · `.sb` | 失败弱背景 |
| `--hatch` | `rgba(255,255,255,.17)` | [starbase.css](../dist/starbase.css) · `.sb` | 未知斜线 |
| `--fill-mine` | `rgba(242,242,239,.16)` | [starbase.css](../dist/starbase.css) · `.sb` | 本人的可信占用填充 |
| `--fill-other` | `rgba(242,242,239,.07)` | [starbase.css](../dist/starbase.css) · `.sb` | 其他可信占用填充 |
| `--primary` | `#F2F2EF` | [starbase.css](../dist/starbase.css) · `.sb` | 主操作底色 |
| `--primary-hover` | `#FFFFFF` | [starbase.css](../dist/starbase.css) · `.sb` | 主操作悬停 |
| `--on-primary` | `#0A0B0D` | [starbase.css](../dist/starbase.css) · `.sb` | 主操作文字 |
| `--on-danger` | `#0A0B0D` | [starbase.css](../dist/starbase.css) · `.sb` | 危险实心操作文字 |
| `--term` | `#060607` | [starbase.css](../dist/starbase.css) · `.sb` | 终端底色 |
| `--term-ink` | `#D8D9D4` | [starbase.css](../dist/starbase.css) · `.sb` | 终端文字 |
| `--scrim` | `rgba(4,5,6,.62)` | [starbase.css](../dist/starbase.css) · `.sb` | 浮层遮罩 |
| `--shadow` | `0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04)` | [starbase.css](../dist/starbase.css) · `.sb` | 大浮层阴影 |
| `--shadow-pop` | `0 12px 32px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.03)` | [starbase.css](../dist/starbase.css) · `.sb` | 小浮层阴影 |
| `--seg-on` | `#2A2C31` | [starbase.css](../dist/starbase.css) · `.sb` | 分段选中背景 |
| `--code-bg` | `rgba(242,242,239,.08)` | [starbase.css](../dist/starbase.css) · `.sb` | 代码弱背景 |
| `--ring` | `var(--ink)` | [starbase.css](../dist/starbase.css) · `.sb` | 键盘焦点环 |
| `--gutter` | `48px` | [starbase.css](../dist/starbase.css) · `.sb` | 页面边距 |
| `--content` | `1280px` | [starbase.css](../dist/starbase.css) · `.sb` | 内容最大宽度 |
| `--edge` | `max(var(--gutter),calc((100% - var(--content)) / 2))` | [starbase.css](../dist/starbase.css) · `.sb` | 页面共同左右对齐边界 |
| `--fs-display` | `56px` | [starbase.css](../dist/starbase.css) · `.sb` | 展示标题字号 |
| `--fs-title` | `40px` | [starbase.css](../dist/starbase.css) · `.sb` | 页面标题字号 |
| `--fs-h2` | `24px` | [starbase.css](../dist/starbase.css) · `.sb` | 抽屉/指南标题字号 |
| `--fs-h3` | `20px` | [starbase.css](../dist/starbase.css) · `.sb` | 区块/对话框标题字号 |
| `--fs-row` | `16px` | [starbase.css](../dist/starbase.css) · `.sb` | 行标题字号 |
| `--fs-body` | `14px` | [starbase.css](../dist/starbase.css) · `.sb` | 正文/按钮/输入字号 |
| `--fs-meta` | `13px` | [starbase.css](../dist/starbase.css) · `.sb` | 次级行/状态/表格字号 |
| `--fs-small` | `12px` | [starbase.css](../dist/starbase.css) · `.sb` | 说明/图例/CJK最小字级字号 |
| `--fs-micro` | `11px` | [starbase.css](../dist/starbase.css) · `.sb` | 等宽元信息字号 |
| `--fs-num-xl` | `48px` | [starbase.css](../dist/starbase.css) · `.sb` | 最大读数字号 |
| `--fs-num-l` | `40px` | [starbase.css](../dist/starbase.css) · `.sb` | 大读数字号 |
| `--fs-num-m` | `32px` | [starbase.css](../dist/starbase.css) · `.sb` | 中读数字号 |
| `--fs-num-s` | `28px` | [starbase.css](../dist/starbase.css) · `.sb` | 小读数字号 |
| `--h-sm` | `32px` | [starbase.css](../dist/starbase.css) · `.sb` | 小控件基础高度 |
| `--h-md` | `40px` | [starbase.css](../dist/starbase.css) · `.sb` | 常规控件基础高度 |
| `--h-lg` | `48px` | [starbase.css](../dist/starbase.css) · `.sb` | 大控件基础高度 |
| `--t-press` | `90ms` | [starbase.css](../dist/starbase.css) · `.sb` | 旧共享按压时长；最终按钮不位移 |
| `--t-quick` | `140ms` | [starbase.css](../dist/starbase.css) · `.sb` | 快速颜色反馈 |
| `--t-base` | `220ms` | [starbase.css](../dist/starbase.css) · `.sb` | 状态/读数基础时长 |
| `--t-move` | `320ms` | [starbase.css](../dist/starbase.css) · `.sb` | 空间移动基础时长 |
| `--t-level` | `480ms` | [starbase.css](../dist/starbase.css) · `.sb` | 可信液位变化时长 |
| `--t-ping` | `900ms` | [starbase.css](../dist/starbase.css) · `.sb` | 旧共享单次样本时长 |
| `--d-hold` | `600ms` | [starbase.css](../dist/starbase.css) · `.sb` | 确认结果停留延迟 |
| `--e-out` | `cubic-bezier(.2,.8,.2,1)` | [starbase.css](../dist/starbase.css) · `.sb` | 进入/收束曲线 |
| `--e-in` | `cubic-bezier(.4,0,1,1)` | [starbase.css](../dist/starbase.css) · `.sb` | 退出曲线 |
| `--e-std` | `cubic-bezier(.2,0,0,1)` | [starbase.css](../dist/starbase.css) · `.sb` | 原位移动/尺寸曲线 |
| `--e-level` | `cubic-bezier(.45,0,.55,1)` | [starbase.css](../dist/starbase.css) · `.sb` | 读数对称曲线 |
| `--bg` | `#F3F3F0` | [starbase.css](../dist/starbase.css) · `.sb.light` | 页面底色 |
| `--bg-1` | `#FFFFFF` | [starbase.css](../dist/starbase.css) · `.sb.light` | 一级表面 |
| `--bg-2` | `#ECECE8` | [starbase.css](../dist/starbase.css) · `.sb.light` | 二级表面 |
| `--bg-3` | `#E3E3DE` | [starbase.css](../dist/starbase.css) · `.sb.light` | 三级/悬停表面 |
| `--bg-4` | `#D8D8D2` | [starbase.css](../dist/starbase.css) · `.sb.light` | 轨道或最高表面 |
| `--line` | `#DEDED8` | [starbase.css](../dist/starbase.css) · `.sb.light` | 基础细线 |
| `--line-2` | `#CDCDC6` | [starbase.css](../dist/starbase.css) · `.sb.light` | 强调边界 |
| `--line-3` | `#B9B9B2` | [starbase.css](../dist/starbase.css) · `.sb.light` | 强边界/轨道 |
| `--ink` | `#0B0C0E` | [starbase.css](../dist/starbase.css) · `.sb.light` | 主文字 |
| `--ink-2` | `#45474D` | [starbase.css](../dist/starbase.css) · `.sb.light` | 次级文字 |
| `--ink-3` | `#63656C` | [starbase.css](../dist/starbase.css) · `.sb.light` | 元信息 |
| `--ink-4` | `#888984` | [starbase.css](../dist/starbase.css) · `.sb.light` | 非文本标记/大字号弱标记 |
| `--run` | `#0A7A46` | [starbase.css](../dist/starbase.css) · `.sb.light` | 运行状态 |
| `--queue` | `#985800` | [starbase.css](../dist/starbase.css) · `.sb.light` | 排队/等待状态 |
| `--prep` | `#0A62B8` | [starbase.css](../dist/starbase.css) · `.sb.light` | 数据准备状态 |
| `--err` | `#C01D2C` | [starbase.css](../dist/starbase.css) · `.sb.light` | 失败状态 |
| `--run-bg` | `rgba(10,122,70,.07)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 运行弱背景 |
| `--queue-bg` | `rgba(152,88,0,.07)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 等待弱背景 |
| `--prep-bg` | `rgba(10,98,184,.07)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 准备弱背景 |
| `--err-bg` | `rgba(192,29,44,.06)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 失败弱背景 |
| `--hatch` | `rgba(11,12,14,.2)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 未知斜线 |
| `--fill-mine` | `rgba(11,12,14,.13)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 本人的可信占用填充 |
| `--fill-other` | `rgba(11,12,14,.06)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 其他可信占用填充 |
| `--primary` | `#0B0C0E` | [starbase.css](../dist/starbase.css) · `.sb.light` | 主操作底色 |
| `--primary-hover` | `#2A2B30` | [starbase.css](../dist/starbase.css) · `.sb.light` | 主操作悬停 |
| `--on-primary` | `#FFFFFF` | [starbase.css](../dist/starbase.css) · `.sb.light` | 主操作文字 |
| `--on-danger` | `#FFFFFF` | [starbase.css](../dist/starbase.css) · `.sb.light` | 危险实心操作文字 |
| `--scrim` | `rgba(20,20,18,.32)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 浮层遮罩 |
| `--shadow` | `0 30px 80px rgba(20,20,18,.18),0 0 0 1px rgba(0,0,0,.05)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 大浮层阴影 |
| `--shadow-pop` | `0 12px 32px rgba(20,20,18,.14),0 0 0 1px rgba(0,0,0,.05)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 小浮层阴影 |
| `--seg-on` | `#FFFFFF` | [starbase.css](../dist/starbase.css) · `.sb.light` | 分段选中背景 |
| `--code-bg` | `rgba(11,12,14,.07)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 代码弱背景 |
| `--ring` | `var(--ink)` | [starbase.css](../dist/starbase.css) · `.sb.light` | 键盘焦点环 |
| `--wm` | `url(内嵌 SVG；完整载荷见源码 .wordmark)` | [starbase.css](../dist/starbase.css) · `.wordmark` | 品牌 SVG 遮罩资产 |
| `--cmd-bg` | `var(--bg-2)` | [starbase.css](../dist/starbase.css) · `.cmd` | 命令区底色 |
| `--cmd-ink` | `var(--ink)` | [starbase.css](../dist/starbase.css) · `.cmd` | 命令区文字 |
| `--cmd-dim` | `var(--ink-3)` | [starbase.css](../dist/starbase.css) · `.cmd` | 命令区弱文字 |
| `--cmd-line` | `var(--line)` | [starbase.css](../dist/starbase.css) · `.cmd` | 命令区边界 |
| `--cmd-hover` | `var(--bg-3)` | [starbase.css](../dist/starbase.css) · `.cmd` | 命令区悬停 |
| `--cmd-ph` | `var(--code-bg)` | [starbase.css](../dist/starbase.css) · `.cmd` | 命令区占位背景 |
| `--bg` | `#0B0C0E` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 页面底色 |
| `--bg-1` | `#111215` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 一级表面 |
| `--bg-2` | `#16171B` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 二级表面 |
| `--bg-3` | `#1E2024` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 三级/悬停表面 |
| `--bg-4` | `#26282D` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 轨道或最高表面 |
| `--line` | `#25272C` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 基础细线 |
| `--line-2` | `#2D2F35` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 强调边界 |
| `--line-3` | `#3B3E45` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 强边界/轨道 |
| `--ink` | `#E8E8E4` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 主文字 |
| `--ink-2` | `#A6A8AE` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 次级文字 |
| `--ink-3` | `#8E9097` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 元信息 |
| `--ink-4` | `#66686F` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 非文本标记/大字号弱标记 |
| `--err` | `#FF6161` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 失败状态 |
| `--code-bg` | `rgba(242,242,239,.1)` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 代码弱背景 |
| `--cmd-bg` | `#0B0C0E` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 命令区底色 |
| `--cmd-hover` | `#1E2024` | [starbase.css](../dist/starbase.css) · `.cmd.dev,.cmd.data` | 命令区悬停 |
| `--fs-display` | `32px` | [starbase.css](../dist/starbase.css) · `.m` | 展示标题字号 |
| `--fs-title` | `28px` | [starbase.css](../dist/starbase.css) · `.m` | 页面标题字号 |
| `--fs-row` | `17px` | [starbase.css](../dist/starbase.css) · `.m` | 行标题字号 |
| `--fs-body` | `15px` | [starbase.css](../dist/starbase.css) · `.m` | 正文/按钮/输入字号 |
| `--fs-num-l` | `32px` | [starbase.css](../dist/starbase.css) · `.m` | 大读数字号 |
| `--gutter` | `16px` | [starbase.css](../dist/starbase.css) · `.m` | 页面边距 |
| `--t-move` | `380ms` | [starbase.css](../dist/starbase.css) · `.m` | 空间移动基础时长 |
| `--gutter` | `24px` | [starbase.css](../dist/starbase.css) · `.sb:not(.m)` | 页面边距 |
| `--gutter` | `16px` | [starbase.css](../dist/starbase.css) · `.sb:not(.m)` | 页面边距 |
| `--tick` | `var(--ink-3)` | [starbase.css](../dist/starbase.css) · `.hero-frame` | 主视觉角标颜色 |
| `--tl` | `14px` | [starbase.css](../dist/starbase.css) · `.hero-frame` | 主视觉角标长度 |
| `--tick` | `var(--ink-3)` | [starbase.css](../dist/starbase.css) · `.light .hero-frame` | 主视觉角标颜色 |
| `--ink` | `#1c2941` | [styles.css](../dist/styles.css) · `:root` | 主文字 |
| `--muted` | `#647187` | [styles.css](../dist/styles.css) · `:root` | 旧组件/指南弱文字 |
| `--line` | `#e4e9f1` | [styles.css](../dist/styles.css) · `:root` | 基础细线 |
| `--accent` | `#345fea` | [styles.css](../dist/styles.css) · `:root` | 旧组件强调色 |
| `--blue-soft` | `#edf2ff` | [styles.css](../dist/styles.css) · `:root` | 旧基础配色，应用有覆盖 |
| `--navy` | `#131e35` | [styles.css](../dist/styles.css) · `:root` | 旧基础配色，应用有覆盖 |
| `--radius` | `14px` | [styles.css](../dist/styles.css) · `:root` | 旧基础组件圆角 |
| `--ink` | `#202b3b` | [styles.css](../dist/styles.css) · `:root` | 主文字 |
| `--muted` | `#647187` | [styles.css](../dist/styles.css) · `:root` | 旧组件/指南弱文字 |
| `--line` | `#e2e7ee` | [styles.css](../dist/styles.css) · `:root` | 基础细线 |
| `--accent` | `#3c59c7` | [styles.css](../dist/styles.css) · `:root` | 旧组件强调色 |
| `--blue-soft` | `#eef2fd` | [styles.css](../dist/styles.css) · `:root` | 旧基础配色，应用有覆盖 |
| `--navy` | `#182338` | [styles.css](../dist/styles.css) · `:root` | 旧基础配色，应用有覆盖 |
| `--surface` | `#fff` | [styles.css](../dist/styles.css) · `:root` | 旧组件表面 |
| `--border` | `var(--line)` | [styles.css](../dist/styles.css) · `:root` | 旧组件边界 |
| `--radius` | `14px` | [styles.css](../dist/styles.css) · `:root` | 旧基础组件圆角 |
| `--sidebar-width` | `220px` | [styles.css](../dist/styles.css) · `:root` | 旧布局侧栏宽度，外壳可重映射 |
| `--sidebar-width` | `196px` | [styles.css](../dist/styles.css) · `:root` | 旧布局侧栏宽度，外壳可重映射 |
| `--ink` | `#19191b` | [styles.css](../dist/styles.css) · `:root` | 主文字 |
| `--muted` | `#626266` | [styles.css](../dist/styles.css) · `:root` | 旧组件/指南弱文字 |
| `--line` | `#dfdfdd` | [styles.css](../dist/styles.css) · `:root` | 基础细线 |
| `--accent` | `#202023` | [styles.css](../dist/styles.css) · `:root` | 旧组件强调色 |
| `--blue-soft` | `#f0f0ee` | [styles.css](../dist/styles.css) · `:root` | 旧基础配色，应用有覆盖 |
| `--navy` | `#111113` | [styles.css](../dist/styles.css) · `:root` | 旧基础配色，应用有覆盖 |
| `--surface` | `#fff` | [styles.css](../dist/styles.css) · `:root` | 旧组件表面 |
| `--border` | `var(--line)` | [styles.css](../dist/styles.css) · `:root` | 旧组件边界 |
| `--radius` | `8px` | [styles.css](../dist/styles.css) · `:root` | 旧基础组件圆角 |
| `--sidebar-width` | `232px` | [styles.css](../dist/styles.css) · `:root` | 旧布局侧栏宽度，外壳可重映射 |
| `--sidebar-width` | `212px` | [styles.css](../dist/styles.css) · `:root` | 旧布局侧栏宽度，外壳可重映射 |

运行期布局变量不当主题或业务读数：`--gpu-count` 由 [resources-ui.js](../dist/resources-ui.js) 设置为真实物理卡数；`--bottom-reserve` 由 [shell-ui.js](../dist/shell-ui.js) 按当前可见固定控制层的真实边界与20px间距计算，并换算为布局坐标；[shell.css](../dist/shell.css) 让各房间和页尾都能滚动到控制层上方。旧数据集矩阵的 `--dataset-columns` 与 `--dataset-min-width` 保留给兼容渲染函数，仓库主界面不再使用矩阵。`--panel` 是 maintenance.css 的可选回退消费项，当前应用未声明；`--vscode-scrollbar-shadow` 是 [xterm.css](../dist/vendor/xterm.css) 的供应商消费项，也没有应用声明。

共享导航玻璃使用主题色混合与 `blur(22px) saturate(1.35)`；阴影只分离浮层。减少透明度时用实色。`.hero-frame` 的四角只围住主视觉，不给每个字段套框。

## 3. 状态语法

共享 `.st` 加状态类，装饰 `.g` 对读屏隐藏，文字保留。形状与文字共同区分状态，颜色不单独承担含义。来源为 [starbase.css](../dist/starbase.css)，任务映射以 [workbench-ui.js](../dist/workbench-ui.js) 的 stateClass/stateWord 为准。

| 类 / 选择器 | 形状与颜色 | 含义与使用 |
| --- | --- | --- |
| `.st-run` | 绿色实点 | 已确认运行，训练卡/轨迹/总控 |
| `.st-start` | 绿色虚线环 | 启动或提交中，不代表已运行 |
| `.st-queue` | 琥珀色空环 | 已知排队或等待 |
| `.st-prep` | 蓝色半填环 | 数据准备/传输，不是进度百分比 |
| `.st-err` | 红色菱形 | 已确认失败，保留错误与恢复入口 |
| `.st-done` | 次级色实点 | 已确认完成，不能由进度100%推断 |
| `.st-stop` | 灰色空方 | 取消或让位已经结束 |
| `.st-cancel` / `.st-stop.pending` | 灰色虚线方 | 取消未确认；任务 PREEMPTING 同形状、文字为让位 |
| `.st-yield` | 琥珀色虚线环 | 共享让位组件，不替换任务模块的映射 |
| `.st-unk` / `.unk` / `.stale` / `.hatch` | 静止斜线与 — | 未知/过期，过期保留最后更新时间 |
| `.resource-tower-bar.locked` | 平涂遮罩 | 未授权，不泄露实时指标；[resources.css](../dist/resources.css) |
| `.maintenance-pause` / `.maintenance-lock-band` / `.maintenance-held` | 暂停、禁入带、短事实 | 维护准入、单台锁定、暂不派发；[maintenance-experience.css](../dist/maintenance-experience.css) |

未知显卡覆盖液位；“没有权限”不能显示为空闲。CSS 隐藏不是数据权限。状态字形半填与斜线是事实符号，不扩展成装饰渐变。

## 4. 组件清单

下表选择器都来自现有实现。组件不授予权限，确认条件和恢复由对应模块与服务器控制。

| 选择器 | 文件 | 何时用 / 不用 | 可访问性与交互 |
| --- | --- | --- | --- |
| `.wordmark` / `.wordmark.sm` | [starbase.css](../dist/starbase.css) | mask 字标与小尺寸；不以字体临摹轮廓 | 保留 STARGATE 名称，重复装饰对读屏隐藏 |
| `.auth-r5-wordmark` / `.auth-lambda` | [auth-ui.js](../dist/auth-ui.js)、[members.css](../dist/members.css) | 登录 SVG 字标与一次点亮；登录前只画静态外形 | 保持 viewBox；减少动态直接终态 |
| `#page-admin` / `.admin-navigation` | [admin-ui.js](../dist/admin-ui.js)、[admin.css](../dist/admin.css) | 独立管理后台；桌面侧栏、窄容器两列导航，只显示有真实 mount 的已注册区块 | 当前区块 aria-current；权限确认后才 mount，离开、换账号或撤权时先 abort 再 unmount |
| `#app-topbar` / `#room-nav` / `.nav-item` | [shell-ui.js](../dist/shell-ui.js)、[shell.css](../dist/shell.css) | 稳定房间导航；不新增独立传输入口 | aria-current，指南始终可达 |
| `#shell-context` / `#context-machine` / `#context-project` | [shell-ui.js](../dist/shell-ui.js) | 代理原服务器/项目控件，不造第二份业务状态 | 标签明确，title完整 ID，同步原控件 |
| `#control-strip` / `.cstrip` / `.cs-progress` | [control-ui.js](../dist/control-ui.js)、[starbase.css](../dist/starbase.css) | 任务/会话/传输/需处理；无对象段收起 | 入口可读，不预测队列位次或终端倒计时 |
| `.mc` / `.mc-natural` / `.mc-natural-fields` | [control-ui.js](../dist/control-ui.js)、[workbench-ui.js](../dist/workbench-ui.js) | 总控与⌘K解析预填；不自动提交 | Esc与焦点，解析字段待确认 |
| `.mc-overview` / `.mc-meter-value` | [control-ui.js](../dist/control-ui.js)、[shell.css](../dist/shell.css) | 总控统计按面板容器宽度排列，560px及以下为2×2 | 数值与单位不折行，标签不在词中断开；保留全部真实统计 |
| `.room-transition-layer` / `.room-ghost` | [shell-ui.js](../dist/shell-ui.js)、[shell.css](../dist/shell.css) | 跨房间快照，同房间页签不使用 | inert、无应用ID/事件钩子，不截操作 |
| `.sheet` / `.modal` / `.dialog` / `.object-transition-layer` | [motion-ui.js](../dist/motion-ui.js)、[starbase.css](../dist/starbase.css) | 详情/提交/确认浮层，不由动画决定状态 | 原生dialog，关闭/返回焦点；克隆去open |
| `.copy-help` / `.copy-help-button` / `.copy-help-popup` / `.ui-info` | [copy-help-ui.js](../dist/copy-help-ui.js)、[copy-help.css](../dist/copy-help.css)、[workbench-ui.js](../dist/workbench-ui.js) | 标签行右侧ⓘ，不用孤立一行/长段说明 | aria-controls/expanded，popover视口限制，键盘关闭；工作台说明按触发器上下可用空间限高、内部滚动，不遮住完整点击区域 |
| `.btn.primary` / `.btn.danger` / `.btn.danger-fill` / `.button.primary` / `.button.quiet` | [starbase.css](../dist/starbase.css)、[styles.css](../dist/styles.css)、[shell.css](../dist/shell.css) | 一个实心主操作，次要安静，破坏性确认代价 | 原生disabled/busy，焦点环，图标有名称 |
| `.segmented` / `.project-environment-segments` / `.dataset-source-tabs` | [starbase.css](../dist/starbase.css)、[workbench.css](../dist/workbench.css)、[datasets.css](../dist/datasets.css) | 少量互斥项，不把长清单塞分段 | 保留radio/legend，明确选中态 |
| `.wb-stage-hero` / `.wb-progress-hero` / `.wb-trajectory` / `.wb-ledger` | [workbench-ui.js](../dist/workbench-ui.js)、[workbench.css](../dist/workbench.css) | 阶段自适应当前训练、真实里程碑、额度账本 | 其他训练仍在列表，无进度不给补数 |
| `.train-grid` / `.field-caption` / `.note-field` | [execution-ui.js](../dist/execution-ui.js)、[workbench.css](../dist/workbench.css) | 同一行的训练参数共享subgrid标签与输入轨道；提交/设置/项目/任务留言字段块用24px、标签到控件用12px | 标签折行仍保持控件上沿对齐；ⓘ保留32/44px点击区域，用负margin保持标签行高度；留言复用原提交契约 |
| `.wb-publish-control` / `.workspace-context-heading .field-caption` | [execution-ui.js](../dist/execution-ui.js)、[workbench.css](../dist/workbench.css) | 创建项目与生成训练版本占满同一列；发布说明并入分组标题右侧现有ⓘ | 保留原说明、操作ID与发布确认；按钮两侧对齐，说明不占操作宽度 |
| `#project-location` / `[name=workspace-project]` | [execution-ui.js](../dist/execution-ui.js)、[shell-ui.js](../dist/shell-ui.js)、[workbench.css](../dist/workbench.css) | 本人授权位置的「我的项目」；个人容器无需先选顶栏机器，开发源和顶栏焦点独立 | 同名项目以源机器区分；终端/文件/发布保留原源，创建按实际environmentModes，原请求取消与迟到回执守卫保留；开发位置单行省略并以title保留完整ID，标题列可收缩，刷新按钮不出视口；未知不当空目录 |
| `#job-mission` / `.r5-mission` | [workbench-ui.js](../dist/workbench-ui.js)、[workbench.css](../dist/workbench.css) | 任务全屏，肖像只画实际分配的卡 | Esc/关闭/返回任务，保留取消日志输出 |
| `.resource-chassis` / `.resource-towers` / `.resource-tower` | [resources-ui.js](../dist/resources-ui.js)、[resources.css](../dist/resources.css) | 真实物理卡位，液位仅表示显存比例 | 手机全部卡位可见，利用率另列，未知斜线 |
| `.resource-portrait-utils` | [resources-ui.js](../dist/resources-ui.js)、[resources.css](../dist/resources.css) | 卡位使用率，按真实卡数生成；窄容器自动换列 | 两位等宽序号与百分比分开8px，序号用次级颜色；不把序号拼成读数 |
| `.ro-v` / `.ro-m` / `.resource-id-label` | [starbase.css](../dist/starbase.css)、[resources-ui.js](../dist/resources-ui.js) | 遥测与巨型服务器 ID，不混淆额度/显存/利用率 | 数值单位分开，保留更新时间和失联事实 |
| `.server-id` / `.server-id-head` / `.server-id-tail` | [workbench-ui.js](../dist/workbench-ui.js)、[shell.css](../dist/shell.css)、[workbench.css](../dist/workbench.css) | 来自清单的 ID，紧凑处省略，部分控件保留尾段 | title完整值，复制/详情不截断 |
| `.hero-frame` | [starbase.css](../dist/starbase.css) | 主视觉四角细框，不给每行加框 | 装饰不抢读屏与点击 |
| `.empty` / `.form-error` / `.publication-unknown` | [styles.css](../dist/styles.css)、[workbench.css](../dist/workbench.css) | 空目录/已知错误/未确认分别表达 | 查询重试保留；未知不自动消失 |
| `.toast` | [starbase.css](../dist/starbase.css)、[shell.css](../dist/shell.css) | 短反馈，不是唯一持久错误证据 | 可换行，需处理留在对象/总控 |
| `.mc-attention-item` / `.mc-attention-actions` | [attention-state.js](../dist/attention-state.js)、[control-ui.js](../dist/control-ui.js)、[shell.css](../dist/shell.css) | 原对象失败/部分成功/未确认，不靠已读清除未知 | 回具体对象，只有已确认失败可按规则确认 |
| `.maintenance-banner` / `#maintenance-experience` / `.maintenance-server-row` | [maintenance-ui.js](../dist/maintenance-ui.js)、[maintenance-experience.js](../dist/maintenance-experience.js) | 全平台维护、单台事实、每台控制行 | 原因原文转义；账号/指南/退出不阻挡 |
| `.maintenance-console-dialog` / `.maintenance-recovery-bar` | [maintenance-experience.js](../dist/maintenance-experience.js)、[maintenance-state.js](../dist/maintenance-state.js) | ROOT、主机、恢复前检查、分阶段恢复 | CAS冲突停止，部分完成逐项列出 |
| `.terminal-dialog` / `.terminal-recovery` | [terminal-ui.js](../dist/terminal-ui.js)、[terminal.css](../dist/terminal.css) | 连接、断开、结束、接管/恢复是不同动作 | 失联不重放，writerToken仅内存 |
| `.warehouse-v3` / `.v3-row` / `.v3-inspector` | [dataset-warehouse-view.js](../dist/dataset-warehouse-view.js)、[dataset-catalog-model.js](../dist/dataset-catalog-model.js)、[dataset-warehouse.css](../dist/dataset-warehouse.css) | 一个逻辑数据集一行，右侧按身份、存放位置、训练用法排列；详情自然撑高，超出视口和底部预留空间时才内部滚动，训练按钮和两条命令留在底栏；手机点击进入详情 | 完整版本与实体缓存 ID 不合并猜测；搜索名称或 ID；所属保留完整提示；数量右对齐等宽数字 |
| `.v3-rail` / `.v3-server-chip` | [dataset-warehouse-view.js](../dist/dataset-warehouse-view.js)、[dataset-warehouse.css](../dist/dataset-warehouse.css) | 按缓存服务器筛选；容量条只取已确认 capacity | filesystemBytes/availableBytes 计算实际数据盘已用比例；读不到不画 0%；长 ID 提示完整值；手机内部横向滚动 |
| `.v3-label-dialog` | [dataset-label-client.js](../dist/dataset-label-client.js)、[dataset-warehouse-view.js](../dist/dataset-warehouse-view.js) | 仅修改本人视图的显示名，不修改训练 ID | fresh GET 回执携带 revision；409 重读后等待明确确认；失联不自动重写；账号代次隔离 |
| `.v3-upload` / `.v3-drop` / `.v3-route` | [dataset-warehouse-view.js](../dist/dataset-warehouse-view.js)、[dataset-warehouse.css](../dist/dataset-warehouse.css) | 先拖放/选择文件，再显示文件摘要、名称、上传服务器及一条探测路线 | 匿名 capabilities 不带票据；门户提供路线无效时显示待确认；保留原链接、云盘、服务器整理流程；原生 dialog 在可见父节点下 |
| `.dataset-ground` / `.dataset-location-icon` / `.dataset-lifecycle` / `.dataset-flow-route` | [dataset-flow.js](../dist/dataset-flow.js)、[dataset-flow.css](../dist/dataset-flow.css) | 数据库原件、缓存、实际来源路线 | 图形有文字/完整版本复制；无字段不画已释放或百分比 |
| `.dataset-cache-admin` / `.dataset-cache-gauge` / `.dataset-cache-preview` | [dataset-cache-admin.js](../dist/dataset-cache-admin.js)、[dataset-flow.css](../dist/dataset-flow.css) | 管理员预算/水位/释放预览，不是实际磁盘水位 | 展开或明确刷新才查询；预览不删除 |
| `.dataset-pin-slot` / `[data-cache-retention]` | [dataset-cache-admin.js](../dist/dataset-cache-admin.js)、[manual-pin-state.js](../dist/manual-pin-state.js) | 管理员固定保留与同账号原请求恢复 | 先按pinId查owner/present，计数不证明归属 |
| `.dataset-more-slot` / `[data-remove-more]` | [dataset-remove-ui.js](../dist/dataset-remove-ui.js)、[datasets-ui.js](../dist/datasets-ui.js)、[dataset-remove.css](../dist/dataset-remove.css) | 管理后台的按机器删除挂载点，主界面不挂管理员管理操作 | 绑定实体身份，整库名称确认；按实际版本列完整保留副本；最后副本或本机未决时禁用；未知查原操作；缺编号的25小时保护说明放入ⓘ，有编号不承诺按时解除 |
| `.dataset-remove-blocked` / `.dataset-remove-action-word` | [dataset-remove-ui.js](../dist/dataset-remove-ui.js)、[dataset-remove.css](../dist/dataset-remove.css) | 已证实未派发的拒绝与禁用原因 | 墨色原文，“按机器删除”不从词中间折行；只有能力确认为1时才提彻底删除；只有已知拒绝可“知道了”移除 |
| `#dataset-add-dialog` / `.dataset-field-label` / `.dataset-directory-control` | [datasets-ui.js](../dist/datasets-ui.js)、[datasets.css](../dist/datasets.css) | 三来源添加数据，中文选择文件夹/合计 | 标签关联，来源说明在标题右侧ⓘ；弹窗内部真实滚动 |
| `.help-links.copy-caption` / `.dataset-storage` | [index.html](../dist/index.html)、[app.js](../dist/app.js)、[datasets-ui.js](../dist/datasets-ui.js)、[datasets.css](../dist/datasets.css) | 数据集主体及可见页尾提示均跟随真实标签 | 页尾「首次使用」在桌面和平板显示，手机断点保持整块隐藏；右侧共享SVG提示保留原说明和指南链接，与标签同中线，不单独占行 |
| `.dataset-upload-journey` / `.dataset-route-heading` | [dataset-flow.js](../dist/dataset-flow.js)、[dataset-upload.js](../dist/dataset-upload.js)、[upload-routes.js](../dist/upload-routes.js) | 三段上传、直传/Tail备用/显式中转，不造数据库阶段 | 未确认通道明示；失败不自动换中转 |
| `.data-workspace-browser` / `#cloud-files-form` / `.cloud-file-details` | [data-workspace.js](../dist/data-workspace.js)、[cloud-files-ui.js](../dist/cloud-files-ui.js)、[datasets.css](../dist/datasets.css) | 在服务器上整理/云端副本，不宣称电脑直接进云盘 | enabled=false说明，VERIFIED前不可取回；记录内区块、折叠后的后续区块统一使用12px间距令牌，关闭详情不保留margin/padding；详情与未确认操作编号的标题保持48px触控高度，文字居中 |
| `.dataset-version-caption` / `.dataset-disclosure-label` | [cloud-files-ui.js](../dist/cloud-files-ui.js)、[datasets.css](../dist/datasets.css) | 数据集版本与云端详情共用折叠标记 | summary使用flex中线；统一▸/▾，切换不旋转，减少动态时保持静止 |
| `.publication-trajectory` / `#publication-actions` | [execution-ui.js](../dist/execution-ui.js)、[workbench-ui.js](../dist/workbench-ui.js)、[workbench.css](../dist/workbench.css) | 扫描/复制/校验/写入版本及原请求查询 | 无字段省略，回执不明不制造成功 |

算力只在该卡所有进程均被节点确认为自己的平台任务时用白色填充，可信新样本才保留旧液位细线并提示差异；首次采样与恢复连接直接呈现当前值，过期或失联显示未知，不保留液位过渡。没有进程证据不等于可以立即启动，监控与训练准入分开。原始指标、进程与队列保留在默认折叠详情；程序、系统用户和节点调度任务ID仅管理员可见，刷新保留所选卡号与滚动位置。

训练全屏的百分比、轮次、指标和ETA来自已确认且未过期的训练上报；没有上报就显示未提供，不按客户端时间估算进度。运行时长与里程碑使用任务时间证据，进度到100%也等待服务器确认终态。

`.publication-unknown` 与 `.room-ghost` 是JS实际附加的DOM状态/快照钩子，没有独立CSS声明；视觉由状态字形、动画层与JS定位控制，不能假定每个状态class都有一块CSS。

版本删除的后端契约见 [BACKEND_API_HANDOFF.md](BACKEND_API_HANDOFF.md) 和 [DATASETS.md](DATASETS.md)。节点能力未确认时不可启用成员删除、彻底删除或隔离恢复；管理员按机器删除保留旧请求和入口；旧节点由 PR-M2 的持久互斥守卫先证明另有完整副本，新节点启用节点保护。成员权限必须来自版本级个人来源证明。彻底删除组件提供独立挂载接口，数据集房间与后台负责入口和当前账号目录，不能仅从后端 API 推断入口已上线。状态展示区分当前隔离、实际恢复、到期清理与结果未确认；历史 `RETIRED` 不能画成数据已删除。门户重启后未完成任务显示“等待继续（门户已重启）”，管理员可继续或取消；明确节点拒绝显示 BLOCKED 和原因。恢复源代表恢复同一任务全部位置，PURGED 位置只显示名称已释放。显式重新上传属于新登记代次，旧删除任务不能重放。

## 5. 房间与文件

[navigation.js](../dist/navigation.js) 将 transfers 归入数据集，保留原控制器/DOM钩子。旧 `#transfers`、⌘K、总控进入 `#datasets/transfers` 页签，同一房间内不做跨房间转场。

| 房间 | 主模块 / 样式 | 主要测试 |
| --- | --- | --- |
| 工作台 | [execution-ui.js](../dist/execution-ui.js)、[workbench-ui.js](../dist/workbench-ui.js)、[workbench.css](../dist/workbench.css)、[workspace.css](../dist/workspace.css) | projects / personal-project / r5 浏览器 |
| 算力总览 | [resources-ui.js](../dist/resources-ui.js)、[resources.css](../dist/resources.css)、[gpu-allocation-ui.js](../dist/gpu-allocation-ui.js) | resources / resource-ids / allocation |
| 数据仓库与上传数据 | [datasets-ui.js](../dist/datasets-ui.js)、[dataset-warehouse-view.js](../dist/dataset-warehouse-view.js)、[dataset-catalog-model.js](../dist/dataset-catalog-model.js)、[dataset-label-client.js](../dist/dataset-label-client.js)、[dataset-upload-metrics.js](../dist/dataset-upload-metrics.js)、[dataset-warehouse.css](../dist/dataset-warehouse.css)、[datasets.css](../dist/datasets.css) | dataset-catalog-model / dataset-label-client / datasets / dataset-upload / dataset-remove |
| 管理后台的数据与存储区块 | [admin-data-storage.js](../dist/admin-data-storage.js)、[admin-data-storage.css](../dist/admin-data-storage.css)、[dataset-cache-admin.js](../dist/dataset-cache-admin.js)、[dataset-remove-ui.js](../dist/dataset-remove-ui.js) | admin-data-storage / dataset-remove / manual-pin-state |
| 彻底删除对话框 | [dataset-full-delete-ui.js](../dist/dataset-full-delete-ui.js)、[dataset-full-delete-state.js](../dist/dataset-full-delete-state.js)、[dataset-remove.css](../dist/dataset-remove.css) | dataset-full-delete-ui 契约与浏览器 |
| 数据集传输与导入页签 | [transfers-ui.js](../dist/transfers-ui.js)、[data-workspace.js](../dist/data-workspace.js)、[cloud-files-ui.js](../dist/cloud-files-ui.js)、[cloud-import-ui.js](../dist/cloud-import-ui.js) | transfers-http / data-workspace / cloud-files / cloud-import |
| 协作区 | [community-ui.js](../dist/community-ui.js)、[community.css](../dist/community.css) | community |
| 后台成员与额度 | [admin-members-ui.js](../dist/admin-members-ui.js)、[app.js](../dist/app.js)、[members.css](../dist/members.css) | admin-members / ui / polish-shell |
| 登录、注册、账号 | [auth-ui.js](../dist/auth-ui.js)、[client.js](../dist/client.js)、[members.css](../dist/members.css)、[shell.css](../dist/shell.css) | client-auth / persistent-login / polish-shell |
| 指南 | [guide.mjs](../guide.mjs)、[USER_GUIDE.md](USER_GUIDE.md)、[guide.css](../dist/guide.css) | guide / user-guide-content |
| 维护 | [maintenance-ui.js](../dist/maintenance-ui.js)、[maintenance-state.js](../dist/maintenance-state.js)、[maintenance-experience.js](../dist/maintenance-experience.js)、[maintenance-experience.css](../dist/maintenance-experience.css) | maintenance / maintenance-background-freeze |

### 管理后台区块注册

`#admin` 打开按 order 排序的第一个已注册区块；`#admin/<id>` 保留区块深链接。账户菜单、总控命令、手机「我的」只在存在已注册区块时向管理员提供入口；匿名和成员访问显示「需要管理员权限」。K1 先提供骨架，各负责人随后在同一个区块 PR 中移走主界面的管理操作并挂到后台，旧能力在迁移前保留。

从 [admin-ui.js](../dist/admin-ui.js) 导入 `registerAdminSection({id,title,order,mount(el,ctx),unmount()})`；注册本身不能发管理请求。`tasks/storage/members/maintenance` 的默认标题依次为「显卡与任务 / 数据与存储 / 成员与额度 / 维护」，区块自己传 `order:10/20/30/40`。同一个 ID 只注册一次，返回函数可注销。默认元数据仅提供标题，不生成占位导航；只有实际注册的区块才显示。零区块时入口隐藏，管理员直接访问返回工作台；未注册的深链接回到第一个已注册区块，成员访问仍显示权限拒绝。

`mount` 只在当前后台区块和已确认的管理员会话下调用，`ctx.store` 沿用现有已认证客户端，`ctx.toast` 显示消息，`ctx.signal` 在离开区块、注销、换账号、撤权或注销注册时中止。请求仍须把 signal 传给 `store.call`，不能仅因注册过就开始请求。卸载先 abort，再调用可选 `unmount()`，最后移除原宿主；晚回包只持有已移除的宿主，旧 toast 不会进入新页面。

额外提供当前身份快照 `ctx.principal`、有生命周期保护的 `ctx.navigate` 和 `ctx.subscribe(render)`；后者立即渲染并随主状态更新调用，返回取消订阅函数。区块自行处理成功、失败和未确认，框架只在 mount 抛错时显示「重新打开」操作，不猜后台状态。此框架不新增接口和动效。

## 6. 动效

成员授权控件仅在 `#admin/members`（order 30）挂载，原桌面、手机和命令面板入口移除；旧 `#users` 重定向到该后台区块。邀请、审批、额度、角色、重置、暂停/恢复和删除仍沿用原接口。区块卸载先关闭弹窗、清除草稿/注册码/确认动作并把控件移回隐藏且 inert 的停车区；异步回包用挂载上下文核验。原成员根节点与控件 ID 保留，布局使用成员容器查询。

动效解释已发生的差异，不决定业务时序。实际规则见 [motion-ui.js](../dist/motion-ui.js)、[shell-ui.js](../dist/shell-ui.js)、[starbase.css](../dist/starbase.css)、[resources-ui.js](../dist/resources-ui.js)、[workbench-ui.js](../dist/workbench-ui.js)、[members.css](../dist/members.css)。

| 时长 / 曲线 | 当前用途 |
| --- | --- |
| 140ms / linear | 颜色与边框悬停；按钮点击不新增缩放 |
| 150ms | 减少动态的原位淡变；部分肖像切换淡入 |
| 180ms / cubic-bezier(.4,0,1,1) | 桌面房间退出，位移24px |
| 200ms | 手机房间标签淡变 |
| 220ms | 首次内容、读数、指示器、状态、普通对话框、toast与多数退出 |
| 280ms / cubic-bezier(.2,.8,.2,1)，延迟60ms | 桌面房间进入，位移24px |
| 320ms / cubic-bezier(.2,0,0,1) | FLIP、桌面sheet、总控/dock揭开、已确认差异细线 |
| 350ms / 同上 | 手机二级push/back，下层位移视口宽度30% |
| 380ms / 同上 | 手机一级提交/详情sheet从底部进入 |
| 480ms / 标准曲线或 --e-level | 可信显存液位、确认发布的单次淡变；不推算读数 |
| 600ms / cubic-bezier(.2,.8,.2,1) | 登录.auth-lambda一次点亮；已点亮的浏览器会话静止 |
| 2.4s / linear | 已知运行透明度提示，未知不播放 |
| 1.6s / linear | 启动字形；取消字形最终覆盖保持静止 |

令牌表保留旧 `--t-press:90ms`、`--t-ping:900ms`、`--d-hold:600ms` 声明，但最终覆盖已取消按钮位移、终端光标闪烁等效果，声明不是新增效果许可。确认结果的停留时间也不是服务器成功证据。

captureObject/sharedObject 用实测矩形做 FLIP，服务器文字允许等比缩放。退出dialog先真正关闭并处理焦点，再播放快照；cleanClone去掉dialog的open、ID、name、form、data/事件钩子，克隆inert/aria-hidden，动画层不拦截操作。房间快照单独清理自己的钩子；不要克隆一个活应用节点作为退场层。

prefers-reduced-motion移除位移、液位变化与循环，必要反馈用150ms原位淡变，登录点亮直接终态；prefers-reduced-transparency使用实色。动画中仍能关闭、取消、切换和换账号，旧动画不能写回新上下文。

## 7. 文案

标题下不放说明段落，每屏解释不超过两行，手机优先一行。ⓘ在标签行右侧，最多两句；长解释进入 [USER_GUIDE.md](USER_GUIDE.md)。维护原因原文、错误、时间、范围和恢复代价保留。不要英文眉标。

添加数据抽屉的来源说明随页签切换，使用标题行的 `.copy-caption`，保留原说明与弹出提示。`.dataset-help-heading` 的文字可换行，ⓘ与文字盒保持同一水平中线；不要把提示放入按钮组、空页脚，或允许它单独换行。折叠头的ⓘ在右端，避免点击折叠头中心时误开提示。上传路线的标签和ⓘ同行，路径独占下一行。

| 避免的页面措辞 | 普通话 |
| --- | --- |
| 自报 | 训练上报 |
| 同步时间 / 陈旧样本 | 更新于 / 上次更新 / 状态待确认 |
| 配额占用的内部状态枚举 | 占用额度，显示已确认事实 |
| OCI 环境 | 个人容器 / 现有环境 |
| archive / SSD / HDD / 归档盘 | 数据仓库长期保存原件；训练读取服务器缓存 |
| evict / GC | 释放空闲缓存，用时取回 |
| 电脑直传云盘 | 先到服务器，再保存云端副本 |

成员界面不出现OCI、CDI、租约、revision、writerToken、宿主机等内部词；代码文档和必要管理员诊断保留协议字段。不可用能力写暂不可用，不删除到用户无法了解；来源和状态仍须真实。

## 8. 真实性与恢复

参照 [BACKEND_API_HANDOFF.md](BACKEND_API_HANDOFF.md)、[PROJECTS.md](PROJECTS.md)、[DIRECT_UPLOAD.md](DIRECT_UPLOAD.md)、[DATASETS.md](DATASETS.md)、[CLOUD_FILES.md](CLOUD_FILES.md)、[TERMINAL_SESSIONS.md](TERMINAL_SESSIONS.md)、[TRANSFERS.md](TRANSFERS.md)。GPUQ_HAS_SESSION和本地记录只辅助恢复显示，不授予权限。

| 流程 | 成功/事实证据 | 缺失或丢回执 |
| --- | --- | --- |
| 生成训练版本 | publication.id等于本次key；publication为READY且release是完整有效哈希；releases里同一release也READY | 保留原账号/服务器/项目/key，先查原项目，明确重试同请求；已确认成功后新的独立发布才能换key |
| 网页直传 | 最后datasets.upload.status对同uploadId为READY，dataset/version有效，totalBytes/entries等于begin本地清单；READY依赖后端完整SHA256校验 | 按节点offset续传；不符显示上传结果与本地清单不符，不标可用 |
| 直传路线 | 核实路线与票据节点/端点/证书/路线一致；raw HTTPS Bearer票据、credentials omit、redirect error、no-store | 续签核对端点证书不变；失败不自动中转；超过256MiB中转明确同意；文件块只在票据明确授权16MiB时按实际ACK耗时从1MiB自适应，清单和中转仍为1MiB |
| 数据仓库原件 | 匹配版本storage.phase=ARCHIVED，originalRetained=true，archiveMachine有值 | 不从服务器角色或目录缺失推断已保存/已释放；冲突/未知显示待确认 |
| 缓存 | 真实location状态，严格canUse与可准备性，加原件证明 | 取回/存入无可信进度就不画百分比，线静止；无storage为服务器缓存、未存入仓库 |
| 缓存容量 | status/plan的enabled一致，plan.usageBytes/budgetBytes和真实高低水位 | disabled=自动释放未开启；不是实际磁盘占用，候选只是释放预览 |
| 固定保留 | 管理员；真实location.dataset+完整版本；原pinId的manualPin.owner/present由服务器证明 | 本地记录刷新变待确认，先读原ID；pinCount只显示处数，不证明归属；仅解除确认的本人保留，不自动补写 |
| 云端副本 | 对应上传/校验已VERIFIED，之后才能取回 | enabled=false说明不可用；未知先查原对象，不重新创建 |
| 终端 | 会话与写权限分别确认，断开/结束/接管分开 | 不重放输入；writerToken仅内存；429退避；退出不结束已确认会话；晚到未采用资源由旧身份屏障清理 |
| 维护恢复 | maintenance.set以当前revision CAS，逐步完成范围明确列出 | 先保护剩余范围，再解除全平台，再恢复选中范围；冲突停止刷新，不自动写重试；服务器最终准入 |
| 需处理 | 原对象UNKNOWN/PARTIAL/UNCONFIRMED事实保留 | 时间或已读不能清除；只有已确认失败可按规则确认 |
| 删除数据集 | 管理员目标/版本或整库范围，服务端实时证明还有完整副本 | 唯一副本或本机未决禁用；409显示原文；SUBMITTING刷新为未确认，查原operationId，不自动再删；放弃查询不清门户持久排除；缺编号只在明确不存在或worker硬上限加1小时之后的新读取仍READY且登记身份不变时解除 |

彻底删除对话框独立于数据集布局：名称确认、48px 危险按钮、实际步骤和恢复期限；不显示推算百分比。目录 `datasetDelete === 1` 才能显示入口；主界面所有人还需当前版本至少一个位置的 `deletionPermissions.memberAllowed === true`，后台管理员不受该字段限制。403 与 BLOCKED 原因保留服务器原文。按账号保存原 UUID key 后才派发，刷新和丢回执只查询原 key；UNKNOWN 仅显示重新查询。有任务编号时直接显示等宽短编号并可复制完整值，没有编号则不渲染。步骤按已证实的原件、缓存或未知角色显示，不以 complete 推断原件。继续、取消和恢复仅出现在后台；普通视图在删除完成后显示「如需恢复，请联系管理员（保留至…）」，只有 BLOCKED、UNKNOWN、WAITING_CONTINUE 提示「需要管理员处理」。恢复核对原操作、服务器、物理名称与版本，再查询原任务。

目录别名用于训练，缓存保留/删除使用location真实本地名称。账号/机器/项目/版本切换停止旧轮询并抛弃旧回复；缓存策略只在展开/明确刷新查询，隐藏房间停止storage RPC。

详情按内容自然撑高，以 CSS sticky 顶部偏移和运行时总控占用计算最大空间；仅超出时让中段滚动、训练底栏固定，四台服务器在 1440×900 和 1024×768 均完整显示。「所属」只显示名字，原 ownerLabel 保留不变。上传连接失败只提供原路线重试与重新探测，不推荐其他来源；其他来源仍在初始选择里。

主界面的管理员和普通成员使用相同仓库组件；只显示个人授权操作，不出现缓存策略、固定保留或云盘连接。独立 [admin-data-storage.js](../dist/admin-data-storage.js) 注册 storage/order20，只有管理后台确认角色并挂载时才读取全所属目录；离开或撤权先 abort 再清理。按机器删除读取新鲜全节点物理登记，固定保留仍绑定原 pinId，容量策略只在展开或显式刷新时读；全局目录可见性不授予任何管理权限。

仓库目录只在打开数据集房间时首次加载，隐藏房间不提前读取节点。上传初始页的其他来源保留云盘导入；打开电脑上传不查询云盘连接能力。云盘扫码和断开授权仍在后台，按钮高度至少44px。

数据仓库允许启用的登录成员浏览全节点元数据，零机器额度仍可浏览。版本与位置的 `canUse` 表示本人使用授权；`READY` 只证明副本状态，不能单独解锁准备或训练。未授权版本简短标为“仅浏览”，不把生命周期画成“可用于训练”；容量、上传、训练和管理员操作仍分别鉴权，不因目录扩大而增加权限或暴露私有路径。

全平台维护原因公开显示在登录页，输入旁保留提醒；单台原因只在登录后显示。账号、协作、指南、维护控制不被执行类维护拦截；管理员ROOT、host操作、只读、取消/断开/结束按现有规则放行。维护开关不会自动停止已有任务或节点。

上传路线只三段：你的电脑→所选服务器缓存→可用于训练；通道另标直传/Tail备用/中转。它不证明数据库原件已经保存，不把存入数据库追加为已完成阶段。

## 9. 响应式与长名称

1440/390/320是原生截图三档，流式布局还覆盖中间宽度与真实浏览器缩放。页面根不横向滚动；仓库服务器筛选栏和原始进程表允许在有名称的内部面板滚动，列表与操作不溢出。

服务器ID来自清单/目录，保留原值，不写死名字。巨型标题按容器缩放，上限160px，桌面下限56px、手机40px；不足则省略并提示完整名称。总控/上下文/矩阵标题省略；工作台server-id-head/tail可保留尾段，复制与完整详情不截断。

759px为主要手机房间/抽屉边界。底栏是工作台、算力总览、数据集、协作区、我的，传输没有独立标签。成员/维护由我的或总控承接。总控胶囊与主操作同行，工作台不重复胶囊；内容为底栏、胶囊、安全区和真实控制层预留空间。

触控目标至少44px，字形可以小，不能缩按钮规避目标。仓库搜索是用户明确指定的40px/14px例外；手机服务器操作仍至少44px，桌面缓存/重试统一32px/13px。minmax(0,1fr)、min-width:0、有边界的换行/省略处理ID、用户名、数据集名、版本与命令。弹窗真实内部滚动，返回恢复焦点与原房间位置，不隐藏DOM冒充适配。

工作台展开项目、文件或主机运维表单时，右栏随页面滚动，避免高于可用视口的吸顶表单把操作停在总控条后面。共享toast宽度受`100vw - 32px`约束，长错误换行并保留全文；缩放后213–256 CSS像素也须可读。训练进度、指标与额度用流式网格，百分比按容器宽度缩放，不以隐藏状态或降低字级避开检查。

## 10. 测试与截图地图

以下是提取基线全部37个独立浏览器入口与137个Node单元入口。浏览器内部还执行共享夹具，不重复把每个夹具当独立入口。Python节点/队列契约见 [TESTING.md](TESTING.md)，使用完整Python3.12安装运行全量。

| 浏览器入口 | 主要房间 / 契约 |
| --- | --- |
| [allocation-ui-smoke.mjs](../tests/allocation-ui-smoke.mjs) | 弹性卡数、自动放置与分配拒绝 |
| [attention-ui-smoke.mjs](../tests/attention-ui-smoke.mjs) | 总控需处理、未知/部分成功保留 |
| [browser-direct-upload-browser.mjs](../tests/browser-direct-upload-browser.mjs) | raw HTTPS数据面与票据真实浏览器契约 |
| [client-auth-smoke.mjs](../tests/client-auth-smoke.mjs) | 旧100ms超时、新延迟登录、cookie与旧终端清理 |
| [cloud-files-ui-smoke.mjs](../tests/cloud-files-ui-smoke.mjs) | 云端副本状态、VERIFIED取回门与身份切换 |
| [cloud-import-capability-ui-smoke.mjs](../tests/cloud-import-capability-ui-smoke.mjs) | 云端导入能力不可用/拒绝 |
| [cloud-import-ui-smoke.mjs](../tests/cloud-import-ui-smoke.mjs) | 保存分享、取回/解压流程与未知恢复 |
| [community-ui-smoke.mjs](../tests/community-ui-smoke.mjs) | 公告、帖子、评论、成员/管理员边界 |
| [data-workspace-ui-smoke.mjs](../tests/data-workspace-ui-smoke.mjs) | 个人数据空间、云端副本与换账号 |
| [dataset-remove-ui-smoke.mjs](../tests/dataset-remove-ui-smoke.mjs) | 管理员单版本/整库删除、未知原编号恢复；数据库原件/其他完整副本/最后副本/未决删除与409、缺编号25小时说明与有编号区别、三宽共享几何 |
| [dataset-last-copy.test.js](../tests/dataset-last-copy.test.js) | 实时可信目录、跨机器互斥、SQLite派发排除与重启、原回执后复核、明确不存在、worker硬上限/宽限期/新读取与身份校验、旧表迁移、零成员授权及HTTP code通路 |
| [node-dataset-unregister.test.py](../tests/node-dataset-unregister.test.py) | 真实节点异步租约/固定保留拒绝均以原编号FAILED且READY保留；旧trash清理时当前READY仍可能被worker稍后删除 |
| [dataset-upload-ui-smoke.mjs](../tests/dataset-upload-ui-smoke.mjs) | 文件夹、直传/中转同意、续传和READY清单核对，标题提示位置及原文 |
| [datasets-ui-smoke.mjs](../tests/datasets-ui-smoke.mjs) | 目录、数据库/缓存、预算、保留与共享几何；[dataset-help-geometry.mjs](../tests/dataset-help-geometry.mjs)验证标签右侧ⓘ及旧布局反例 |
| [fixed-upload-routes-browser.mjs](../tests/fixed-upload-routes-browser.mjs) | 固定校园/Tail路线探测与严格票据匹配 |
| [admin-members-ui-smoke.mjs](../tests/admin-members-ui-smoke.mjs) | 后台 order30、主界面无成员入口、审批、草稿保护、卸载和晚回包、成员拒绝及四档几何 |
| [admin-ui-smoke.mjs](../tests/admin-ui-smoke.mjs) | 后台入口、成员与匿名拒绝、注册顺序、AbortSignal与跨账号卸载、1440/390/320及流式几何 |
| [guide-ui-smoke.mjs](../tests/guide-ui-smoke.mjs) | 指南导航、移动目录与可达性 |
| [job-diagnostics-ui-smoke.mjs](../tests/job-diagnostics-ui-smoke.mjs) | 训练诊断/历史/日志状态 |
| [job-notifications-ui-smoke.mjs](../tests/job-notifications-ui-smoke.mjs) | 任务通知操作与恢复 |
| [job-progress-ui-smoke.mjs](../tests/job-progress-ui-smoke.mjs) | 训练上报、未知/超时进度 |
| [maintenance-ui-smoke.mjs](../tests/maintenance-ui-smoke.mjs) | 会员阻挡、ROOT、分阶段恢复CAS和公开原因提示 |
| [persistent-login-ui-smoke.mjs](../tests/persistent-login-ui-smoke.mjs) | 持久会话、退出与匿名清单隔离 |
| [personal-project-ui-smoke.mjs](../tests/personal-project-ui-smoke.mjs) | 个人容器创建、选项、终端与发布 |
| [placement-ui-smoke.mjs](../tests/placement-ui-smoke.mjs) | 自动服务器放置与提交确认 |
| [polish-rooms-ui-smoke.mjs](../tests/polish-rooms-ui-smoke.mjs) | 协作、成员、云端副本及抽屉提示/折叠间距的完整测量 |
| [polish-shell-ui-smoke.mjs](../tests/polish-shell-ui-smoke.mjs) | 外壳、账号、成员、指南和维护强化布局 |
| [priority-ui-smoke.mjs](../tests/priority-ui-smoke.mjs) | 普通/最低/管理员优先级 |
| [projects-ui-smoke.mjs](../tests/projects-ui-smoke.mjs) | 项目发布回执、原key恢复与内嵌终端 |
| [r5-ui-smoke.mjs](../tests/r5-ui-smoke.mjs) | 阶段hero、全屏、自然命令、额度与登录品牌 |
| [resource-ids-ui-smoke.mjs](../tests/resource-ids-ui-smoke.mjs) | 长ID巨型标题缩放、省略与提示 |
| [resources-ui-smoke.mjs](../tests/resources-ui-smoke.mjs) | 卡位、液位、角色进程、未知与手机抽屉 |
| [scheduling-ui-smoke.mjs](../tests/scheduling-ui-smoke.mjs) | 训练优先级和队列准入 |
| [starbase-ui-smoke.mjs](../tests/starbase-ui-smoke.mjs) | 共享界面适配与原工作流 |
| [task-metadata-ui-smoke.mjs](../tests/task-metadata-ui-smoke.mjs) | 任务名、署名与不可伪造归属 |
| [task-notes-legacy-ui-smoke.mjs](../tests/task-notes-legacy-ui-smoke.mjs) | 旧能力节点不提供任务说明入口 |
| [task-notes-ui-smoke.mjs](../tests/task-notes-ui-smoke.mjs) | 任务说明、版本冲突与跨账号 |
| [terminal-contract-ui-smoke.mjs](../tests/terminal-contract-ui-smoke.mjs) | 不重放、内存writer、429、接管、断开/结束 |
| [transfers-http-ui-smoke.mjs](../tests/transfers-http-ui-smoke.mjs) | 真实门户传输准入、上传、进度与身份 |
| [ui-polish-smoke.mjs](../tests/ui-polish-smoke.mjs) | 综合明度/字号/断点与多个布局夹具 |
| [ui-smoke.mjs](../tests/ui-smoke.mjs) | 整体角色、注册、零授权、资源与手机流程 |

单元表取首个字面量回归名称，仅用于定位；不能以这一行替代整文件执行。

| Node入口 | 首个字面量回归（源码名称） |
| --- | --- |
| [accounts.test.js](../tests/accounts.test.js) | Chinese login names retain identity and administrative authorization |
| [admin-retirement.test.js](../tests/admin-retirement.test.js) | named administrator can retire bootstrap admin without losing administration |
| [aliyun-protocol.test.js](../tests/aliyun-protocol.test.js) | share-download uses the upstream web-share canary header |
| [aliyun-races.test.js](../tests/aliyun-races.test.js) | QR result has a finite ten-minute local lifetime |
| [api-cli.test.js](../tests/api-cli.test.js) | real CLI and browser API share accounts and permissions; reset revokes prior sessions |
| [attention-state.test.js](../tests/attention-state.test.js) | failure time prefers the completed attempt and accepts existing seconds, milliseconds and ISO dates |
| [auto-placement.test.js](../tests/auto-placement.test.js) | auto normalization is explicit, canonical and does not contaminate manual retry identity |
| [bridge-availability.test.js](../tests/bridge-availability.test.js) | absent or refused executor socket is a safe 503 and never exposes its path |
| [browser-direct-upload.test.js](../tests/browser-direct-upload.test.js) | browser chooses a fixed alternate anonymously before ticketing and retains it on renewal |
| [browser-route-guard.test.js](../tests/browser-route-guard.test.js) | route teardown only tolerates the three documented cancellation errors |
| [browser-transfer-consent.test.js](../tests/browser-transfer-consent.test.js) | browser transfer wrapper forwards explicit relay consent outside the manifest |
| [cancel-drain-live.test.js](../tests/cancel-drain-live.test.js) | HTTP Portal cancel retains quota after real native cancel and releases only after native drain |
| [cancel-persistence.test.js](../tests/cancel-persistence.test.js) | ${pending?'pending':'not dispatched'} cancellation ${failure} failure rolls back intent, audit and memory; reopen preserves state/quota |
| [cli-native-platform.test.js](../tests/cli-native-platform.test.js) | native client works with a loopback mock API and Unicode Windows-style workflows |
| [client-auth.test.js](../tests/client-auth.test.js) | old successful calls cannot write data/principal or return results across logout and new login |
| [client-build.test.js](../tests/client-build.test.js) | normal bundler follows nested modules, resolves name collisions, and produces identical bytes |
| [client-docker-context.test.js](../tests/client-docker-context.test.js) | all current Docker COPY sources survive the context, including Windows and guide files |
| [client-http.test.js](../tests/client-http.test.js) | read-only 502 during deployment retries and returns the actual status result |
| [cloud-files-api.test.js](../tests/cloud-files-api.test.js) | member cloud operations force actor identity and bypass no account authority |
| [cloud-files-ui.test.js](../tests/cloud-files-ui.test.js) | verified own files offer reverify as well as restore; pending files keep check action |
| [cloud-files-verification.test.js](../tests/cloud-files-verification.test.js) | pending cloud metadata is confirmed with bounded backoff against exactly one owner and original receipt |
| [cloud-files-worker.test.js](../tests/cloud-files-worker.test.js) | worker upload hashes the exact inherited descriptor and emits bounded stages |
| [cloud-import-client.test.js](../tests/cloud-import-client.test.js) | HTTPS resume replaces only the short link on the same operation ID |
| [cloud-import-v050-ui.test.js](../tests/cloud-import-v050-ui.test.js) | share capability requires an explicit verified fact; login and nodeDirect do not prove it |
| [cloud-import.test.js](../tests/cloud-import.test.js) | only official share references and safe relative target paths are accepted |
| [cloud-lane.test.js](../tests/cloud-lane.test.js) | public invoke dispatches cloud operations and returns compact response |
| [cloud-v050-ui.test.js](../tests/cloud-v050-ui.test.js) | queued, running, verifying and unknown are not reliable copies; only VERIFIED permits restore |
| [clouddrive-files.test.js](../tests/clouddrive-files.test.js) | disabled/unverified gates, node-only role and trusted budget requirements |
| [clouddrive-provider.test.js](../tests/clouddrive-provider.test.js) | disabled and unverified gates make no RPC calls |
| [community-cli.test.js](../tests/community-cli.test.js) | post prints the retry key before network, reuses it and retains response fields |
| [community-ui.test.js](../tests/community-ui.test.js) | unknown sends retain the original key and reject changed payload until confirmed |
| [community.test.js](../tests/community.test.js) | community info has explicit bounds and only small public author fields are exposed |
| [configure.test.js](../tests/configure.test.js) | deployment inventory accepts separate domains and arbitrary machine capacity |
| [data-route-ui.test.js](../tests/data-route-ui.test.js) | routes require an explicit known transport, never infer a campus path |
| [data-workspace-cli.test.js](../tests/data-workspace-cli.test.js) | data put chunks one file into personal data without extraction, publication or selected project context |
| [data-workspace-client.test.js](../tests/data-workspace-client.test.js) | data terminal is a distinct personal scope without project or ROOT inheritance |
| [dataset-catalog.test.js](../tests/dataset-catalog.test.js) | list projects only trusted authorized usernames, not IDs, guessed prefixes or user records |
| [dataset-file-identity.test.js](../tests/dataset-file-identity.test.js) | Windows unknown/64-bit path device compatibility is limited to path-to-handle checks |
| [dataset-flow.test.js](../tests/dataset-flow.test.js) | each immutable version has one identity-bound slot for the row and mobile card more menu, without a placeholder action |
| [dataset-label-cli.test.js](../tests/dataset-label-cli.test.js) | display label reads current canonical identity then CAS writes one personal name |
| [dataset-labels.test.js](../tests/dataset-labels.test.js) | personal readable names persist without changing dataset identifiers, files, versions or leases |
| [dataset-preparation.test.js](../tests/dataset-preparation.test.js) | slow node observation does not block mutations; cancellation prevents dispatch or cache-worker cancellation |
| [dataset-remove-ui.test.js](../tests/dataset-remove-ui.test.js) | unregister submits exactly one scoped target and polls only the server operation ID at 2/5/10 seconds |
| [dataset-replication.test.js](../tests/dataset-replication.test.js) | approved direct transfer is preparable but not falsely local READY |
| [dataset-unregister-api.test.js](../tests/dataset-unregister-api.test.js) | whole-dataset unregister requires authenticated admin despite full member GPU grants |
| [dataset-upload-cli.test.js](../tests/dataset-upload-cli.test.js) | standalone CLI uploads a directory with empty files/directories and resumes a lost chunk response |
| [dataset-upload-client.test.js](../tests/dataset-upload-client.test.js) | incremental browser SHA256 matches native hash at padding boundaries and random chunk boundaries |
| [datasets-api.test.js](../tests/datasets-api.test.js) | opt-in dataset preparation is durable, reserves no GPU and dispatches only after local READY |
| [datasets-guide.test.js](../tests/datasets-guide.test.js) | production guide serves formatted chapters and removes public operations manuals |
| [datasets-ui.test.js](../tests/datasets-ui.test.js) | dataset cards show one concise username label, never guess from the dataset prefix |
| [direct-upload-api.test.js](../tests/direct-upload-api.test.js) | direct ticket and revoke use authenticated personal identity and existing machine grant |
| [direct-upload-client-integration.test.js](../tests/direct-upload-client-integration.test.js) | real Node pinned client uploads raw bytes to real Python HTTPS endpoint, publishes SHA-verified version |
| [direct-upload-client.test.js](../tests/direct-upload-client.test.js) | direct grants require a bounded, pinned HTTPS origin and short expiration |
| [direct-upload-large-chunks-client.test.js](../tests/direct-upload-large-chunks-client.test.js) | large direct-file capability is optional and strictly bounded |
| [direct-upload-policy.test.js](../tests/direct-upload-policy.test.js) | CSP permits only operator-configured exact HTTPS origins |
| [elastic-allocation.test.js](../tests/elastic-allocation.test.js) | elastic task rows retain rank-only controls and advisory training progress together |
| [execution-submit-races.test.js](../tests/execution-submit-races.test.js) | a delayed lookup never replaces the newest fixed dataset choice on the same machine |
| [execution.test.js](../tests/execution.test.js) | approval required, optimistic grant writes, maximum GPU access is not administrator |
| [git-snapshot.test.js](../tests/git-snapshot.test.js) | fixed Git snapshots stream blobs larger than the command buffer and retain Unicode paths and empty files |
| [gpu-placement.test.js](../tests/gpu-placement.test.js) | shared task row retains placement, rank, progress and private notification controls |
| [gpuq-status.test.js](../tests/gpuq-status.test.js) | live status expires closed and never exposes legacy job owners to members |
| [guide-workflow.test.js](../tests/guide-workflow.test.js) | guide separates optional CLI installation and code upload from dataset publishing |
| [host-api.test.js](../tests/host-api.test.js) | full GPU grants never allow host exec/status/cancel; authentication is enforced before bridge |
| [host-cli.test.js](../tests/host-cli.test.js) | host exec is non-TTY, argv-exact, server-selected and separate from project terminals |
| [install-client-windows.test.js](../tests/install-client-windows.test.js) | Windows installer pins an HTTPS origin and bounds same-origin downloads |
| [invites.test.js](../tests/invites.test.js) | role comes from invite, ordinary signup has zero grants, secrets are not persisted or exposed |
| [job-completion.test.js](../tests/job-completion.test.js) | explicit completion verifies same immutable job later success without changing failed history or quotas |
| [job-diagnostics-api.test.js](../tests/job-diagnostics-api.test.js) | diagnostics allows owner/admin, uses immutable server spec, and does not rewrite RUNNING from error evidence |
| [job-diagnostics-ui.test.js](../tests/job-diagnostics-ui.test.js) | exact lease history keeps actual acquisition/release separate from attempt times and marks truncated/migrated rows |
| [job-notifications-live.test.js](../tests/job-notifications-live.test.js) | HTTP-downloaded CLI opts in through actual RPC and fake official API sends only to private mapped owner |
| [job-notifications.test.js](../tests/job-notifications.test.js) | notification default is off and only exact owner may choose existing private destination |
| [job-observation.test.js](../tests/job-observation.test.js) | same-attempt pending retry is observed without changing canceled lifecycle, holds or quota |
| [job-progress-live.test.js](../tests/job-progress-live.test.js) | downloaded watch queries real API without controls; advisory100% stays RUNNING and UNKNOWN retains quota |
| [job-progress.test.js](../tests/job-progress.test.js) | bounded progress projection discards identity/unknown fields and validates metrics and counters |
| [job-terminal-live.test.js](../tests/job-terminal-live.test.js) | native cancel before drain stays UNKNOWN with quota; downloaded watch only inspects, and releases only after native finalize |
| [job-timing.test.js](../tests/job-timing.test.js) | historical terminal projection distinguishes node exit from fourteen-hour-later portal observation without mutation |
| [login-sessions.test.js](../tests/login-sessions.test.js) | SQLite stores only random token hashes; neither hashes nor malformed credentials authenticate |
| [maintenance-api.test.js](../tests/maintenance-api.test.js) | all obsolete writes return 410 for members/admins without dispatch or durable changes |
| [maintenance-background-freeze.test.js](../tests/maintenance-background-freeze.test.js) | global maintenance preserves real WAITING_CLIENT/FAILED data and source protections byte-for-byte across timer ticks and restart |
| [maintenance-http-cli.test.js](../tests/maintenance-http-cli.test.js) | legacy HTTP clients receive 410 and immutable historical records remain readable |
| [maintenance-recovery.test.js](../tests/maintenance-recovery.test.js) | global staged recovery protects remaining machines first and carries real CAS revisions |
| [manual-machine.test.js](../tests/manual-machine.test.js) | manual target is mandatory and exact; invalid values cannot reserve, refresh or dispatch |
| [manual-pin-state.test.js](../tests/manual-pin-state.test.js) | exact own proof, not pin count, authorizes release; fresh reload only reads the same ID |
| [model.test.js](../tests/model.test.js) | demo authorization and requests follow renamed inventory IDs |
| [native-maintenance-integration.test.js](../tests/native-maintenance-integration.test.js) | reconcile sends native labels beside the unchanged spec through the installed bridge |
| [native-task-metadata-http.test.js](../tests/native-task-metadata-http.test.js) | authenticated Portal submit/reconcile reaches REAL native queue metadata, with no resubmit or spec edits |
| [native-task-metadata.test.js](../tests/native-task-metadata.test.js) | new node envelope carries real names beside, NEVER inside, old immutable execution spec |
| [native-task-presentation-http-cli.test.js](../tests/native-task-presentation-http-cli.test.js) | downloaded CLI reads bounded native-only labels for administrators, preserves native ownership and member redaction, and never dispatches |
| [navigation.test.js](../tests/navigation.test.js) | transfer routes identify the dataset room and use one canonical tab URL |
| [oci-cohort-api.test.js](../tests/oci-cohort-api.test.js) | actual account grant/revoke events and first project access sync only server-derived cohort |
| [oci-cohort.test.js](../tests/oci-cohort.test.js) | default OFF makes no node call and does not create bookkeeping |
| [operational-maintenance.test.js](../tests/operational-maintenance.test.js) | operational state is independent, persistent, explicitly restored and revision fenced |
| [persistent-login-http.test.js](../tests/persistent-login-http.test.js) | HTTP fixture does not reuse a deliberately retired keep-alive socket or replay authentication |
| [personal-project-ui.test.js](../tests/personal-project-ui.test.js) | all environment choices confirm the requested project and retain the shared legacy default |
| [portal-image.test.js](../tests/portal-image.test.js) | every transitive local Portal module exists at its runtime COPY path |
| [portal.test.js](../tests/portal.test.js) | VPS accounts, policies and hashed login sessions survive restart, no default demo logins or raw tokens |
| [priority-api.test.js](../tests/priority-api.test.js) | rank edits preserve yield and restart and expose intermediate P1/P3 |
| [priority-ui.test.js](../tests/priority-ui.test.js) | rank editor offers five levels and does not promise different yielding |
| [project-environment-ui.test.js](../tests/project-environment-ui.test.js) | project environment label preserves old shared default and makes isolation explicit |
| [project-replication.test.js](../tests/project-replication.test.js) | fixed owner OCI copies are durable, idempotent, private and never use datasets or GPU jobs |
| [project-upload-recovery.test.js](../tests/project-upload-recovery.test.js) | lost middle ACK queries and resumes same ID without resending accepted bytes |
| [projects-api.test.js](../tests/projects-api.test.js) | project upload status is read-only, owner-bound and usable during maintenance |
| [projects-cli.test.js](../tests/projects-cli.test.js) | project create/use is verified and remembered per machine; changing server never reuses another project |
| [projects-ui.test.js](../tests/projects-ui.test.js) | project slug validation is exact and never coerces paths or array values |
| [r5-views.test.js](../tests/r5-views.test.js) | Chinese training commands resolve only explicit authorized machines, counts and full data references |
| [rename.test.js](../tests/rename.test.js) | rename preserves legacy encrypted invitation and only explicit rotation changes it |
| [resources-ui.test.js](../tests/resources-ui.test.js) | process priorities are displayed only when matched; member view omits job identity |
| [run-sync.test.js](../tests/run-sync.test.js) | sync flag stays before argv separator; Windows paths are literal option values |
| [scheduling-cli.test.js](../tests/scheduling-cli.test.js) | standalone downloaded CLI sends canonical scheduling and preserves argv after -- |
| [scheduling-policy.test.js](../tests/scheduling-policy.test.js) | rank never implies yielding; all five ranks exist with retained admin boundary |
| [snapshot-sync-api.test.js](../tests/snapshot-sync-api.test.js) | fixed code provenance authorizes both nodes and checks manifest before target begin |
| [snapshot-sync-cli.test.js](../tests/snapshot-sync-cli.test.js) | Git preview leaves target unchanged; clean commit copies code into a fenced new draft and resumes a lost reply |
| [starbase-view.test.js](../tests/starbase-view.test.js) | a reachable host with failed/missing scheduler health or duplicate cards is never reported free |
| [storage-archive-api.test.js](../tests/storage-archive-api.test.js) | authority retirement binds certified replacement and preserves unrelated archive access |
| [storage-archive-enroll-cli.test.js](../tests/storage-archive-enroll-cli.test.js) | CLI enrollment sends only fixed owner/ref/key and rejects implicit or privileged options |
| [storage-archive-enroll-live.test.js](../tests/storage-archive-enroll-live.test.js) | same-origin fixture discards a deliberately reset peer without replaying requests or login |
| [storage-archive-ui.test.js](../tests/storage-archive-ui.test.js) | managed archive uses dataset retry instead of a broken generic copy resume |
| [storage-download-lifecycle.test.js](../tests/storage-download-lifecycle.test.js) | feature-on download holds one durable identity across all reads and explicit completion |
| [storage-management-api.test.js](../tests/storage-management-api.test.js) | real HTTP storage requires current admin even for a fully granted member |
| [storage-management-cli.test.js](../tests/storage-management-cli.test.js) | storage CLI maps default status full status and plan while preserving JSON envelopes |
| [submission-contract.test.js](../tests/submission-contract.test.js) | one CLI option registry handles old/new flags, aliases, repetition and literal training argv |
| [task-metadata-api.test.js](../tests/task-metadata-api.test.js) | same-machine members see submitter name/description but no command, logs or task-control authority |
| [task-metadata-http-cli.test.js](../tests/task-metadata-http-cli.test.js) | downloaded standalone CLI, bearer/cookie API and public resource metadata share one persisted contract |
| [task-metadata.test.js](../tests/task-metadata.test.js) | shared validators keep unicode/plain-text metadata bounded and distinct from executable argv |
| [task-notes-integration.test.js](../tests/task-notes-integration.test.js) | reconciliation and restart clean only confirmed terminal task notes |
| [task-notes-ui.test.js](../tests/task-notes-ui.test.js) | notes task choices are own nonterminal jobs, retaining UNKNOWN and waiting tasks |
| [task-notes.test.js](../tests/task-notes.test.js) | task  |
| [terminal-latency-api.test.js](../tests/terminal-latency-api.test.js) | terminal exchange bypasses a slow data request and returns only compact authorized output |
| [terminal-ui-races.test.js](../tests/terminal-ui-races.test.js) | late ${first} cannot replace newer ${second} or keep its writer |
| [transfers-api.test.js](../tests/transfers-api.test.js) | administrator prepare receipts use effective permissions for same-owner transfer status and list |
| [transfers-cli-options.test.js](../tests/transfers-cli-options.test.js) | transfer options pass the common CLI gate but remain scoped to their action |
| [transfers-client.test.js](../tests/transfers-client.test.js) | real local files resume from persisted offsets with SHA256 and final-directory promotion |
| [ui-accessibility.test.js](../tests/ui-accessibility.test.js) | user-list refresh restores the focused user, not the selected user, without scrolling |
| [upload-routes.test.js](../tests/upload-routes.test.js) | only complete fixed HTTPS descriptors are probed; identity and revision both required |
| [user-guide-content.test.js](../tests/user-guide-content.test.js) | user guide source contains no captured command diagnostics |
| [vendor.test.js](../tests/vendor.test.js) | vendored terminal bundles match the lockfile-installed upstream packages |
| [workbench-history.test.js](../tests/workbench-history.test.js) | 204 failed terminal jobs belong to history, preserving every failure and input record |
| [workspace-get-response.test.js](../tests/workspace-get-response.test.js) | one MiB personal reads omit the dashboard but retain exact result and trusted identity for both roles |

新增能力至少覆盖成功、失败、未确认、丢回执、原编号恢复、跨账号与零授权；写入不能自动重复。真实浏览器检查数字右对齐、标签/ⓘ、长文本、内外滚动、焦点与可操作元素，不只查源码字符串。

[layout-geometry.mjs](../tests/layout-geometry.mjs)是共享测量器，不能放宽阈值、隐藏元素或关掉断言。[dataset-flow-browser-fixture.mjs](../tests/dataset-flow-browser-fixture.mjs)完整扫描为两角色×六状态加详情/三来源弹窗×三真缩放，共60场景，每场景59宽×3高=177组，总计10620。缩放使用真实DPR上下文与对应视口，不用CSS transform冒充。角色、目录、容量、票据与丢回执明确来自测试数据。

共享测量器另有四项默认关闭的关系规则：`sameRowControls:[{parent,children,wrap?}]`要求同一视觉行控件上沿差不超过1px；`unbrokenValues:[selector]`检查数字与单位的真实文本行，允许同一基线上的不同字号；`tokenGap:[{parent,left,right,minimum?}]`检查相邻文本的水平间距，默认至少6px；`siblingGap:[{parent,children,textBounds?,together?,wrap?}]`要求连续同级字段块的间距一致，或按文本边界比较标签到控件的间距，差值不超过1px。现有规格不启用时，既有规则与结果保持不变。工作台、算力、总控的[polish-operational-ui-smoke.mjs](../tests/polish-operational-ui-smoke.mjs)按各组件关系启用，包含长标签、间距不足、数值折行的FAIL/PASS回归；[operational-geometry.mjs](../tests/operational-geometry.mjs)还检查真实滚动裁切、焦点目标和完整错误内容。

提交抽屉的「训练位置」和「候选服务器」沿用字段标签行、24px字段块间距和12px标签间距。两种角色覆盖当前服务器、自动选机、长标签及两处说明展开，启用`sameRowControls`、`siblingGap`和标签右侧ⓘ检查；选机说明仍更新原`training-target-note`节点，开发服务器、项目与固定训练版本保持原选机契约。

截图用真实1440/390/320视口，包含成员/管理员与正常/空/加载/失败/未确认/维护；鼠标移开，清除无关焦点，焦点行为另测。展示完整控件与上下文，长卡用真实滚动和较高原生视口，不裁操作、不拼接、不改图。长ID通过独立本地清单验证，公共 [machines.js](../dist/machines.js)保持示例；真实资产、用户数据与生产图不提交。

同步维护令牌作用域、组件引用与测试清单。文档改动至少完整npm test、文档测试（如有）、git diff --check，并核对每个变量、选择器与链接存在；PR写确切提交和实际通过范围。功能改动仍按 [CONTRIBUTING.md](../CONTRIBUTING.md)跑全量Python、浏览器与构建，并经维护者批准合并和部署。
