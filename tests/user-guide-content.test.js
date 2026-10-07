import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const guide = readFileSync(new URL('../docs/USER_GUIDE.md', import.meta.url), 'utf8');
const datasetManual = readFileSync(new URL('../docs/DATASETS.md', import.meta.url), 'utf8');
const chapters = [
  ['首次使用', 'start'],
  ['项目开发', 'development'],
  ['提交训练', 'training'],
  ['数据集', 'data'],
  ['日志与结果', 'results'],
  ['排队与协作', 'queue'],
  ['常见问题', 'troubleshooting'],
];

test('user guide source contains no captured command diagnostics', () => {
  assert.match(guide, /^# 使用指南\r?\n/, 'The guide must begin with its user-facing title');
  assert.doesNotMatch(guide, /^(?:git:\s+(?:warning|error):|fatal:|npm (?:WARN|ERR!)\b|Traceback \(most recent call last\):)/m);
});

test('guide explains authorization labels and keeps personal model inputs separate from datasets',()=>{
  assert.match(guide,/共享授权用户/);assert.match(guide,/不把授权用户当成创建者/);
  assert.match(guide,/各机授权不同/);assert.match(guide,/旧节点未完整提供归属/);
  assert.match(guide,/个人预训练权重、tokenizer 和模型配置.*`\/workspace\/weights`/);
  assert.match(guide,/`\/workspace\/models`/);assert.match(guide,/`\/workspace\/tokenizers`/);
  assert.match(guide,/只读的固定输入/);assert.match(guide,/数据集只登记训练、验证、测试样本/);
  assert.match(guide,/不登记为数据集/);assert.match(guide,/不要覆盖输入权重/);
  assert.match(guide,/不用每次从电脑重新上传/);assert.match(guide,/服务器内部复制快照/);
  assert.match(guide,/新训练产生的 checkpoint 和其他输出仍写每个任务独立的 `\/outputs`/);
});

test('data organization guidance favors reusable collections without changing immutable identity', () => {
  const section = guide.split('### 数据整理约定\n')[1]?.split('\n### ')[0]?.split('网页只有一个')[0];
  assert.ok(section, 'The data chapter contains a concise organization section');
  assert.equal((section.match(/^- /gm) || []).length, 3);
  assert.match(section, /完整、可复用的集合/);
  assert.match(section, /同一集合更新时保留名称，用新的内容版本区分/);
  assert.match(section, /显示名称应说明内容和用途/);
  assert.match(section, /不要只用纯数字、随机字符/);
  assert.match(section, /不要故意登记没有独立复用用途的零散临时小数据集/);
  assert.match(section, /主体或分片尽量合并，训练程序按需选取子集/);
  assert.match(section, /预训练权重、tokenizer 和模型配置放个人项目/);
  for (const path of ['weights/', 'models/', 'tokenizers/', '/outputs']) assert.ok(section.includes('`' + path + '`'));
  assert.match(section, /不登记为数据集/);
  assert.match(section, /内部数据集 ID 或完整 64 位版本哈希/);
  assert.match(section, /内部 ID 和已发布版本保持不可变/);
  assert.match(section, /个人显示名，不做全局重命名/);
  assert.match(guide, /gpuctl data label DATASET_ID --display-name/);
  assert.match(guide, /训练的 `--data` 仍使用原 `DATASET_ID@VERSION`/);
});

test('dataset reference repeats organization rules and preserves existing name and permission contracts', () => {
  const section = datasetManual.split('## 数据整理约定\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'The dataset reference contains the same organization rules');
  assert.equal((section.match(/^- /gm) || []).length, 3);
  assert.match(section, /完整、可复用的集合/);
  assert.match(section, /同一集合更新时保留名称，用新的内容版本区分/);
  assert.match(section, /显示名称说明内容和用途，不只用纯数字、随机字符/);
  assert.match(section, /不要故意登记没有独立复用用途的零散临时小数据集/);
  assert.match(section, /预训练权重、tokenizer 和模型配置放个人项目/);
  assert.match(section, /新训练产物写 `\/outputs`，不登记为数据集/);
  assert.match(section, /不改变上传名称的接口规则/);
  assert.match(section, /内部数据集 ID 和完整 64 位版本哈希保持不可变/);
  assert.match(section, /不做全局重命名，也不改变读取授权/);
  assert.match(section, /训练继续使用原始 `NAME@VERSION`/);
  assert.match(datasetManual, /名称使用 1–40 位字母、数字、下划线或连字符/);
  assert.match(datasetManual, /数据集与来源编号使用 1–64 位 ASCII 字母、数字、下划线或连字符/);
});

test('user guide has the seven stable chapters used by the website', () => {
  const headings = [...guide.matchAll(/^## (.+) \{#([a-z-]+)\}$/gm)].map(match => [match[1], match[2]]);
  assert.deepEqual(headings, chapters);
  assert.equal((guide.match(/^## /gm) || []).length, chapters.length);
  const slugs = new Set(chapters.map(([, slug]) => slug));
  for (const [, slug] of guide.matchAll(/\]\(\/guide\/([^)#/]+)(?:#[^)]*)?\)/g)) {
    assert.ok(slugs.has(slug), `Unknown guide chapter: ${slug}`);
  }
});

test('guide uses the supported simple page formatting without admin manuals', () => {
  assert.equal((guide.match(/^```/gm) || []).length % 2, 0, 'Code fences must be paired');
  assert.doesNotMatch(guide, /^\s*\|.*\|\s*$/m, 'Avoid tables in the chapter renderer');
  assert.doesNotMatch(guide, /^ {2,}(?:[-*]|\d+\.)\s/m, 'Avoid nested lists');
  assert.doesNotMatch(guide, /ADMIN_README|\/guide\/admin|\]\([^)]*\.md(?:#.*?)?\)/);
  assert.doesNotMatch(guide, /gpuctl (?:ssh[^\n]*--root|host\b)|sudo python3|systemctl/);
});

test('first-time users can install and select an actual machine without joining Tail', () => {
  assert.match(guide, /Node\.js 22\.13/);
  assert.match(guide, /https:\/\/gpu\.example\.com\/install\.sh/);
  assert.match(guide, /https:\/\/gpu\.example\.com\/install\.ps1/);
  assert.match(guide, /Windows 可直接使用 PowerShell/);
  assert.match(guide, /不需要 WSL/);
  assert.match(guide, /不需要安装 Tailscale/);
  assert.match(guide, /gpuctl login[\s\S]*gpuctl state[\s\S]*gpuctl use MACHINE_ID/);
  assert.match(guide, /新账号的用卡额度为 0/);
  assert.match(guide, /机器 ID/);
  assert.doesNotMatch(guide, /\bgpu-\d+\b/, 'server arguments use the catalog ID parameter, never an example server name');
});

test('training walkthrough distinguishes local edits, published snapshots and output files', () => {
  for (const command of ['gpuctl push .', 'gpuctl project publish', 'gpuctl project status', 'gpuctl run -g 1 --', 'gpuctl pull --job JOB_ID']) {
    assert.ok(guide.includes(command), `Missing workflow command: ${command}`);
  }
  assert.match(guide, /所有开发终端/);
  assert.match(guide, /默认使用最新的 `READY` 版本/);
  assert.match(guide, /可能用到旧代码/);
  assert.match(guide, /结果、日志文件和 checkpoint 要写入 `\/outputs`/);
  assert.match(guide, /不会自动搬运代码、环境、数据或结果/);
  assert.doesNotMatch(guide, /Podman/, 'Keep engine administration out of the user guide');
});

test('run sync guide distinguishes verified publication from a mirror or environment installer', () => {
  assert.match(guide, /gpuctl run --sync -g 1 --/);
  assert.match(guide, /--sync-dir "C:\\研究代码\\我的项目"/);
  assert.match(guide, /本次发布的 UUID/);
  assert.match(guide, /不可变版本清单/);
  assert.match(guide, /不提交训练/);
  assert.match(guide, /不是增量镜像或删除同步/);
  assert.match(guide, /不会替你结束终端、安装依赖/);
});

test('terminal instructions correctly separate new sessions, detach and explicit reconnect', () => {
  assert.match(guide, /每次 `gpuctl ssh` 都会\*\*新建独立终端\*\*/);
  assert.match(guide, /gpuctl ssh --reconnect SESSION_ID/);
  assert.match(guide, /Ctrl\+\]/);
  assert.match(guide, /`exit` 结束的终端不能重连/);
  assert.match(guide, /开发终端\*\*没有 GPU\*\*/);
  assert.match(guide, /不能直接填入 VS Code Remote-SSH/);
});

test('ordinary-user datasets document campus direct upload without relay recommendations', () => {
  assert.match(guide, /普通成员可以上传个人数据/);
  for (const command of ['gpuctl data upload ./my-data --name my-data --via direct', 'gpuctl data upload-status UPLOAD_ID', 'gpuctl data upload-discard UPLOAD_ID', 'gpuctl data prepare DATASET_ID@VERSION', 'gpuctl data status DATASET_ID@VERSION']) {
    assert.ok(guide.includes(command), `Missing data command: ${command}`);
  }
  assert.match(guide, /先连接能访问上传节点的校园网络/);
  assert.match(guide, /`--via direct` 只允许直传/);
  assert.match(guide, /不经过 VPS 文件中转/);
  assert.match(guide, /客户端会显示实际传输路径/);
  assert.match(guide, /路线显示「直传到」所选服务器，路径中没有门户中转或备用入口/);
  assert.match(guide, /如果页面只提供中转或无法确认路线，先停止/);
  assert.match(guide, /节点入口不可达时上传会停止/);
  assert.match(guide, /重复原上传命令可续传/);
  assert.match(guide, /直传断开不会偷偷改走中转/);
  assert.match(guide, /数百 GB／TB 本机数据使用校内直传，或联系管理员协助外接硬盘导入/);
  assert.match(guide, /500,000/);
  assert.match(guide, /64 MiB/);
  assert.match(guide, /不必重复准备/);
  assert.match(guide, /不要把数据集直传当作所有文件操作的传输路线/);
  assert.doesNotMatch(guide, /--via relay|gpuctl data put\b/);
});

test('public guide excludes cloud and link-import workflows until they are ready for members', () => {
  assert.doesNotMatch(guide, /云盘|云端副本|阿里云|CD2|分享链接|下载链接|链接导入|HTTPS.*直链/);
  assert.doesNotMatch(guide, /gpuctl data (?:cloud|imports?)(?:\s|-|$)/m);
  assert.match(guide, /服务器上已有的文件在个人数据空间整理/);
  assert.match(guide, /不是另一条电脑上传通道/);
  assert.match(guide, /不会自动解压/);
  assert.match(guide, /发布保留可写目录并生成独立只读副本/);
});

test('unified dataset guide distinguishes catalog, capacity and preparation from training readiness', () => {
  assert.match(guide, /网页只有一个“数据集”入口/);
  assert.match(guide, /仓库列表按数据集显示，服务器栏筛选缓存位置/);
  assert.match(guide, /「所属」显示授权记录对应的用户名，省略重复前缀/);
  assert.match(guide, /完整 `--data ID@版本`/);
  assert.match(guide, /`\/data2\/ID` 只读路径读取/);
  assert.match(guide, /数据集 → 上传数据 → 在服务器上整理/);
  assert.match(guide, /相同数据集 ID 和完整版本才合并显示/);
  assert.match(guide, /不是个人硬磁盘配额/);
  assert.match(guide, /`PREPARING_DATA` 表示正在准备所选机器的本地数据，暂不占 GPU 额度/);
  assert.match(guide, /全部就绪后重新核验项目、授权和额度，才进入显卡队列/);
  assert.match(guide, /没有可用来源或权限不足时拒绝提交，不会偷偷换机器/);
  assert.match(guide, /管理员启用节点间私网传输后/);
  assert.match(guide, /其他已授权机器上的固定 READY 版本/);
  assert.match(guide, /仅看到其他机器有数据，不保证通道已启用或当前能复制/);
  assert.match(guide, /失败时先在数据集页或 `data prepare` 明确重试/);
});

test('collaboration uses posts and chat while root requests stay retired', () => {
  assert.match(guide, /只有“帖子”和“聊天”两个入口/);
  assert.match(guide, /展开聊天里的“任务留言”/);
  assert.match(guide, /旧维护申请流程已停用/);
  assert.match(guide, /现有共享\/隔离 Python 环境继续可用，但不能通过 `sudo apt` 修改宿主机/);
});

test('new projects use OCI without a mode choice and distinguish container from host root',()=>{
  assert.match(guide,/新项目统一使用个人容器，不需要选择环境模式/);
  assert.match(guide,/gpuctl project create system-project`/);
  assert.doesNotMatch(guide,/gpuctl project create [^\n`]+--env-mode/);
  assert.match(guide,/容器内 root 不是服务器 root，开发阶段无 GPU/);
  assert.doesNotMatch(guide,/宿主机 root/);
  assert.match(guide,/没开通的服务器会直接拒绝，不影响已有资料/);
  assert.match(guide,/创建按钮不可用时，先刷新项目，仍未确认就联系管理员/);
  assert.match(guide,/网页从「我的项目」进入个人容器.*不用先选顶栏服务器/);
  assert.match(guide,/切换顶栏服务器不会搬迁当前容器、文件或开发终端/);
  assert.match(guide,/训练固定该镜像版本并只见调度分配的 GPU/);
  assert.match(guide,/shared\/isolated Python 模式的 `\/tmp`/);
  assert.match(guide,/容器可写层，占用工作区磁盘，是否有个人硬配额取决于节点配置/);
  assert.match(guide,/只有管理员另行启用并验收内核配额的节点，才具有个人磁盘硬上限/);
  assert.match(guide,/容器已开通不等于硬配额已开通/);
});

test('personal container guidance separates creation, no-GPU development, ending and a pinned training version',()=>{
  const section=guide.split('### 个人容器\n')[1]?.split('\n### ')[0];
  assert.ok(section,'personal containers have their own concise section');
  assert.match(section,/新建项目.*个人容器/);assert.match(section,/容器内 root 不是服务器 root，开发阶段无 GPU/);
  assert.match(section,/同一项目只保留一个开发终端/);assert.match(section,/断开.*不能用于发布/);
  assert.match(section,/本次发布已确认/);assert.match(section,/结果未确认时先重新查询/);
  assert.match(section,/先选好要训练的版本.*训练固定该镜像版本/);assert.match(section,/不会改动已经提交的训练/);
  assert.match(guide,/输入未确认，未自动重发.*暂停输入，直到你明确重连/);
  assert.match(guide,/接管会让另一处失去输入权，已发出的命令不能撤回/);
});

test('guide explains quotas, interruption and failure evidence without promising runtime health', () => {
  assert.match(guide, /普通成员的排队、启动、运行和状态待确认任务都会计入额度/);
  assert.match(guide, /共享和独占任务均免个人累计用卡额度，无需执行 `grant --full`/);
  assert.match(guide, /单个任务仍不能超过所选机器的物理卡数，不豁免实际显存、节点授权和调度约束/);
  assert.match(guide, /资源不足时正常排队，不会因为管理员身份抢停其他训练/);
  assert.match(guide, /每人最多 10 个准备中任务、全平台 5000 条任务历史/);
  assert.match(guide, /降为普通成员后，新提交及尚未派发的任务重新受个人额度约束/);
  assert.match(guide, /不自动重跑/);
  assert.match(guide, /不保证每个 worker 都健康/);
  assert.match(guide, /gpuctl diagnostics JOB_ID --json/);
  assert.match(guide, /本次尝试的退出码是 `latestAttempt.exitCode`/);
  assert.match(guide, /`latestAttempt.startedAt` \/ `latestAttempt.finishedAt`（Unix 秒）/);
  assert.match(guide, /`workerStartedAt` \/ `workerFinishedAt` 使用 ISO 日期时间/);
  assert.match(guide, /缺值表示未确认，不猜成退出码 0 或时间 0/);
  assert.match(guide, /不会自动备份/);
  assert.match(guide, /不要粘贴密码、令牌、私钥/);
});

test('personal data terminal manual extraction separates mutable drafts from immutable training data',()=>{
  for(const command of ['gpuctl data shell','unzip samples.zip -d samples','gpuctl data publish samples --name samples','gpuctl data workspace-status OPERATION_ID'])assert.ok(guide.includes(command));
  assert.match(guide,/确认 `samples.zip` 已在个人数据目录中/);
  assert.match(guide,/只对应\*\*你在当前服务器上的可写目录/);
  assert.match(guide,/不会自动解压/);
  assert.match(guide,/独立只读副本/);
  assert.match(guide,/尚无独立磁盘硬配额/);
});

test('troubleshooting separates confirmed misunderstandings from unavailable features', () => {
  const section = guide.split('## 常见问题 {#troubleshooting}\n')[1];
  assert.ok(section);
  assert.match(section, /失败记录会保留，不代表必须重跑/);
  assert.match(section, /gpuctl completion JOB_ID --json/);
  assert.match(section, /只有 `completed:true` 且任务、项目、发布版本都符合预期/);
  assert.match(section, /节点能力未确认.*503/);
  assert.match(section, /不等于训练程序已经运行并失败/);
  assert.match(section, /保留原任务编号和 `Submission key`，不要另建一份训练/);
  assert.match(section, /节点配置的安全预留；这不是个人容量额度用完/);
  assert.match(section, /数据 `READY` 不等于已备份/);
  assert.match(section, /旧数据不会自动补归档/);
  assert.match(section, /已经永久取消的归档要由管理员核查/);
  assert.match(section, /要另开独立会话，选「新建终端」或运行 `gpuctl ssh`/);
  assert.match(section, /同一个人容器项目仍只保留一个开发终端/);
  assert.match(section, /发布代码和环境前，相关终端须确认 `STOPPED`/);
  assert.match(section, /gpuctl terminal status SESSION_ID/);
  assert.match(section, /`UNKNOWN` 不能当成已结束/);
  assert.doesNotMatch(section, /确认已结束才新建/);
  assert.match(section, /个人容器内 root 只管理自己的容器/);
  assert.match(section, /`--hami` 可用不代表 `--sm-percent 50` 已开通/);
  assert.match(section, /代码、环境和结果仍留在原实例/);
  assert.match(section, /旧环境不会因分组或归档自动变成个人容器/);
});

test('project manual agrees with the guide on verified upload resumption', () => {
  const projects = readFileSync(new URL('../docs/PROJECTS.md', import.meta.url), 'utf8');
  assert.match(projects, /先核对原上传 ID、路径、文件大小与 SHA-256/);
  assert.match(projects, /从服务器已确认的字节继续/);
  assert.match(projects, /旧记录缺少恢复证明或提交结果未确认时停止/);
  assert.match(projects, /不自动替换未完成上传/);
  assert.doesNotMatch(projects, /失败重跑 `push` 会重新传该文件|同路径重传替换未完成上传/);
});
