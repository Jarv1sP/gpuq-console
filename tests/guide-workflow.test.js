import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseCLIOptions} from '../cli.mjs';
import {parseGuide} from '../guide.mjs';

const source=readFileSync(new URL('../docs/USER_GUIDE.md',import.meta.url),'utf8');
const blocks=[...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map(m=>m[1]);
const words=line=>(line.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)||[]).map(word=>/^['"]/.test(word)?word.slice(1,-1):word);

test('guide CLI examples use real registered options, with pending task-metadata commands explicitly gated',()=>{
  let parsed=0,pending=0;
  for(const block of blocks)for(const line of block.trim().split('\n')){
    if(!line.startsWith('gpuctl '))continue;
    const argv=words(line).slice(1);
    if(['profile','queue'].includes(argv[0])||argv.includes('--description')){
      pending++;assert.match(source,/姓名与描述（需任务信息新版）/);assert.match(source,/不要把指南更新当作功能已经上线/);continue;
    }
    const result=parseCLIOptions(argv);assert.ok(result.positionals.length,line);parsed++;
    if(argv[0]==='run')assert.ok(result.training.length,'run needs executable argv after --: '+line);
  }
  assert.ok(parsed>=25);assert.equal(pending,4);
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
  for(const token of ['sync git','sync code','sync data','CODE_READY','check-attr --source','申请系统维修','maintenance request'])assert.ok(chapters.get('troubleshooting').includes(token),token);
  assert.match(chapters.get('queue'),/退出码 75/);assert.match(chapters.get('troubleshooting'),/不立即执行，也不给你 root/);
});
