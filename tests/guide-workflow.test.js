import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseCLIOptions} from '../cli.mjs';
import {parseGuide} from '../guide.mjs';

const source=readFileSync(new URL('../docs/USER_GUIDE.md',import.meta.url),'utf8');
const blocks=[...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map(m=>m[1]);
const words=line=>(line.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)||[]).map(word=>/^['"]/.test(word)?word.slice(1,-1):word);

test('guide separates optional CLI installation and code upload from dataset publishing',()=>{
  const chapters=parseGuide(source);
  assert.match(chapters.get('start'),/仅使用网页无需安装客户端或 Node\.js/);
  assert.match(chapters.get('start'),/使用命令行时，自己的电脑需要 Node\.js 22\.13/);
  assert.match(chapters.get('development'),/不会登记或发布数据集/);
  assert.match(chapters.get('development'),/不会自动排除数据目录，不要把数据集混进代码目录/);
  assert.doesNotMatch(chapters.get('development'),/不会上传数据集/);
});

test('guide CLI examples use registered options and optional transfer rollout is explicit',()=>{
  let parsed=0,metadata=0,transfers=0;
  for(const block of blocks)for(const line of block.trim().split('\n')){
    if(!line.startsWith('gpuctl '))continue;
    const argv=words(line).slice(1);
    if(['profile','queue'].includes(argv[0])||argv.includes('--description'))metadata++;
    if(argv[0]==='transfer')transfers++;
    const result=parseCLIOptions(argv);assert.ok(result.positionals.length,line);parsed++;
    if(argv[0]==='run')assert.ok(result.training.length,'run needs executable argv after --: '+line);
  }
  assert.ok(parsed>=25);assert.equal(metadata,4);assert.ok(transfers>=6);
  assert.match(source,/姓名与描述（需任务信息新版）/);assert.match(source,/不要把指南更新当作功能已经上线/);
  assert.match(source,/管理员启用后的可选能力/);assert.match(source,/不会因更新客户端自动开放/);
});
test('copy blocks never silently undo the preceding upload, subscription or note creation',()=>{
  for(const block of blocks){
    assert.ok(!(block.includes('data upload ./')&&block.includes('upload-discard')));
    assert.ok(!(block.includes('notify JOB_ID on')&&block.includes('notify JOB_ID off')));
    assert.ok(!(block.includes('note --job')&&block.includes('note-delete')));
    assert.ok(!(block.includes('maintenance request')&&block.includes('maintenance withdraw')));
    assert.ok(!(block.includes('project publish')&&block.includes('gpuctl run')));
    assert.ok(!(block.includes('data prepare')&&block.includes('gpuctl run')));
  }
  assert.match(source,/仅当想放弃未完成上传/);assert.match(source,/只在想关闭通知时/);
  assert.match(source,/作者可用.*note-delete.*管理员可删除他人留言/);
});
test('guide covers merged workflow changes while keeping completion, permissions and adaptation boundaries',()=>{
  const chapters=parseGuide(source);
  for(const token of ['--rank P1','--yield never','--yield now','--yield save','--mode preempt1','--mode preempt2','--restart-policy on-preempt'])assert.ok(chapters.get('queue').includes(token),token);
  assert.match(chapters.get('training'),/P2、`yield=never`、`mode=queue`/);
  assert.match(chapters.get('training'),/1、2、4、8/);assert.match(chapters.get('training'),/空闲 3 张时启动 2 张/);
  assert.match(chapters.get('training'),/不支持弹性、自动让位、自动恢复或主动抢占/);
  assert.match(chapters.get('results'),/Ctrl\+C 只停止查看/);assert.match(chapters.get('results'),/管理员为你的账号配置 Telegram/);
  for(const token of ['sync git','sync code','sync data','CODE_READY','check-attr --source','缺少系统依赖','旧维护申请流程已停用'])assert.ok(chapters.get('troubleshooting').includes(token),token);
  assert.match(chapters.get('queue'),/退出码 75/);assert.match(chapters.get('troubleshooting'),/不能提交脚本申请 root/);
  assert.doesNotMatch(source,/gpuctl maintenance (?:request|approve|withdraw)/);
  assert.match(chapters.get('data'),/已经开始的服务器校验会继续/);assert.match(chapters.get('data'),/没有整份已发布数据集的一键下载入口/);
  assert.doesNotMatch(chapters.get('data'),/云盘|云端副本|分享链接|链接导入|data (?:cloud|import)/);
  assert.match(chapters.get('data'),/gpuctl data upload \.\/my-data --name my-data --via direct/);
  assert.match(chapters.get('data'),/gpuctl transfer upload \.\/my-data --name my-data --via direct/);
  assert.match(chapters.get('data'),/入口不可达时停止，不改走中转/);
  assert.match(chapters.get('data'),/连续无输入 1 小时或累计 6 小时/);
  for(const token of ['传输任务新版','transfer upload','transfer download','transfer copy','transfer cancel','WAITING_CLIENT'])assert.ok(chapters.get('data').includes(token),token);
  assert.match(chapters.get('data'),/不要把指南更新当作功能已经上线/);assert.match(chapters.get('data'),/终止后不可恢复/);
  assert.match(chapters.get('data'),/不会因更新客户端自动开放/);assert.match(chapters.get('data'),/LAN copy 还需管理员配置并核验节点间接口/);
  assert.doesNotMatch(source,/没有后台 URL 下载按钮|不提供后台 URL 下载队列/);
});
