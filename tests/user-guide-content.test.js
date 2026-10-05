import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const guide = readFileSync(new URL('../docs/USER_GUIDE.md', import.meta.url), 'utf8');
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

test('ordinary-user datasets include resumable upload, fixed references and large-transfer guidance', () => {
  assert.match(guide, /普通成员可以上传个人数据/);
  for (const command of ['gpuctl data upload ./my-data --name my-data', 'gpuctl data upload-status UPLOAD_ID', 'gpuctl data upload-discard UPLOAD_ID', 'gpuctl data prepare DATASET_ID@VERSION', 'gpuctl data status DATASET_ID@VERSION']) {
    assert.ok(guide.includes(command), `Missing data command: ${command}`);
  }
  assert.match(guide, /网页上传按服务器能力选择路线：可直传时直接传到服务器，否则经平台中转；页面会标出本次实际路线。/);
  assert.match(guide, /直传失败不会自动改走中转；超过 256 MiB 的中转需要你确认。/);
  assert.match(guide, /个人数据空间上传和 `data put` 仍经平台中转。/);
  assert.doesNotMatch(guide, /网页(?:目录)?上传(?:和\s+`data put`)?\s*仍(?:走|经(?:过)?)平台中转/);
  assert.match(guide, /校内直传或外接硬盘导入/);
  assert.match(guide, /500,000/);
  assert.match(guide, /64 MiB/);
  assert.match(guide, /不必重复准备/);
  assert.match(guide, /`data upload` 的实际路径以客户端显示为准/);
  assert.match(guide, /超过 256 MiB 默认停止并提示选择/);
  assert.match(guide, /--via relay/);
  assert.match(guide, /直传断开不会偷偷改走中转/);
  assert.match(guide, /链接导入由服务器直接下载/);
});

test('link-import guidance explains authorization, manual extraction and partial-data retention', () => {
  assert.match(guide, /阿里云盘分享链接或 HTTPS 文件直链/);
  assert.match(guide, /需管理员启用可用的下载通道，并完成后台授权和真实下载验收/);
  assert.match(guide, /未启用或连接不可用时，先使用 HTTPS 直链/);
  assert.match(guide, /不能浏览管理员的云盘或取得账号令牌/);
  assert.match(guide, /当前支持分享根目录的文件，不递归导入文件夹/);
  assert.match(guide, /VPS 只传递授权、链接和进度信息，不搬运文件内容/);
  for (const command of ['gpuctl data import ', 'gpuctl data imports', 'gpuctl data import-status IMPORT_ID', 'gpuctl data import-resume IMPORT_ID', 'gpuctl data import-cancel IMPORT_ID']) assert.ok(guide.includes(command));
  assert.match(guide, /停止下载，但保留临时数据/);
  assert.match(guide, /平台不会自动解压、执行文件、发布或复制到其他机器/);
});

test('unified dataset guide distinguishes catalog, capacity and preparation from training readiness', () => {
  assert.match(guide, /网页只有一个“数据集”入口/);
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

test('optional OCI guide requires node enablement and distinguishes container from host root',()=>{
  assert.match(guide,/管理员已启用的节点/);
  assert.match(guide,/gpuctl project create system-project --env-mode oci/);
  assert.match(guide,/容器内 root 不是服务器 root，开发阶段无 GPU/);
  assert.doesNotMatch(guide,/宿主机 root/);
  assert.match(guide,/没开通的服务器会直接拒绝，不影响你已有的项目/);
  assert.match(guide,/页面上没有「个人容器」选项，就说明你的账号或这台服务器还没开通/);
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
  assert.match(guide, /排队、启动、运行和状态待确认的任务都会计入你的额度/);
  assert.match(guide, /不自动重跑/);
  assert.match(guide, /不保证每个 worker 都健康/);
  assert.match(guide, /gpuctl diagnostics JOB_ID --json/);
  assert.match(guide, /不会自动备份/);
  assert.match(guide, /不要粘贴密码、令牌、私钥/);
});

test('personal data terminal manual extraction separates mutable drafts from immutable training data',()=>{
  for(const command of ['gpuctl data put samples.zip','gpuctl data shell','unzip samples.zip -d samples','gpuctl data publish samples --name samples','gpuctl data workspace-status OPERATION_ID'])assert.ok(guide.includes(command));
  assert.match(guide,/只对应\*\*你在当前服务器上的可写目录/);
  assert.match(guide,/不会自动解压/);
  assert.match(guide,/独立只读副本/);
  assert.match(guide,/尚无独立磁盘硬配额/);
});
