# 协作区

登录后打开侧栏“协作区”。这里只有两个入口：

- **帖子**：公告、问题反馈和讨论放在同一个列表，用类型筛选。重要内容在这里留存。
- **聊天**：交流使用计划、协调排队。聊天记录最多保留 30 天、5,000 条。

所有登录成员都能参与，无需先获得 GPU 额度。内容对全体成员可见，不要发送密码、令牌或私密数据。

## 发帖与回复

点击“发帖”，选择“问题反馈”或“讨论”。反馈请写明操作步骤、服务器或任务 ID、错误现象；打开帖子后可回复、补充进展。

作者可编辑、删除自己的内容。管理员可以更新反馈状态、删除违规内容；只有管理员可以发布、置顶或共同编辑公告，不能改写成员的普通帖子和回复。修改需要当前版本；遇到冲突请刷新后再编辑，草稿不会自动覆盖他人的改动。

公告和聊天约定不会自动停机、取消训练、调整配额或改变排队顺序。

## 聊天里的任务留言

需要让大家看到某个任务的使用计划时，展开聊天底部“任务留言”。可关联自己的未结束任务，确认结束后自动清理；也可选择手动保留。旧留言及 `gpuctl notes`、`gpuctl note` 命令仍可使用，不会因入口调整被删除。任务状态未知或取消尚未确认时，关联留言继续保留。

## 在命令行中参与

沿用 `gpuctl login` 的账号，不需要额外密钥或加入新的网络。

```sh
gpuctl community posts
gpuctl community posts --kind feedback
gpuctl community show 12
gpuctl community post --title "训练日志读取失败" --body-file feedback.txt
gpuctl community comment 12 --body "已补充复现步骤"
gpuctl community comments 12
gpuctl community chat --body "我的训练预计 18:00 结束"
gpuctl community edit 12 --revision 2 --body-file revised.txt
```

列表分页使用返回的 `--cursor`；脚本可加 `--json`。文件内容须为 UTF-8 纯文本。服务器保存文本，不执行 HTML 或脚本。

管理员发布更新公告：

```sh
gpuctl community post --kind announcement --title "平台更新" --body-file release.txt --pin --key UUID
gpuctl community pin 12 off --revision 3
```

把 `UUID` 换成这次发布固定的提交键，可先用 `node -e "console.log(crypto.randomUUID())"` 生成。CLI 未提供 `--key` 时会自动生成，并在请求前输出到 stderr；请保留它。

**发送结果不确定时，30 天内使用相同账号、相同内容和相同 `--key` 重试。** 不会重复发帖；同一个键换内容会被拒绝。去重记录超过 30 天会清理，之后应先查询原帖，不能依靠旧键重发。编辑按 `revision` 检查，超时后先重新读取帖子，确认内容和版本再操作。

## 限制与 API

标题最多 120 字，帖子正文 8,000 字、回复 4,000 字、聊天和留言 2,000 字；各自 UTF-8 字节上限为字数的 3 倍。每人每分钟最多新建 3 篇帖子、10 条回复、20 条聊天，所有写操作合计不超过 60 次。达到限额会明确报错，不会静默丢弃。

`POST /api/call` 使用现有 Bearer 登录会话或网页登录会话：

```json
{"operation":"community.posts.create","args":{"key":"固定的UUID","kind":"announcement","title":"平台更新","body":"已验收的更新内容","pinned":true}}
```

`community.posts.list/get/update/delete`、`community.comments.list/create/update/delete` 和 `community.chat.list/send/update/delete` 共用现有身份验证。公告类型可选 `notice`、`maintenance`、`outage`；初始置顶与发帖在同一事务提交。能力 `announcement-publish-v1` 表示后台支持初始置顶及管理员共同编辑公告。所有写入校验账号、权限、限流及内容长度。

任务留言 API `community.notes.*` 与 `task-notes-v1` 保留兼容。发送过程中请保留网页，重试同一按钮；页面草稿不写入长期浏览器存储，关闭页面或退出账号会清除。
