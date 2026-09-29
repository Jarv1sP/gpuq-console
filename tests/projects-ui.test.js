import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validProject,readyReleases,trainingProject,datasetReferences,uploadProjectFile,taskTable} from '../dist/execution-ui.js';
import {terminalContext} from '../dist/terminal-ui.js';

const release='a'.repeat(64),future='b'.repeat(64);
test('project slug validation is exact and never coerces paths or array values',()=>{
  for(const value of ['vision','a','vision-baseline_2','a'.repeat(48)])assert.equal(validProject(value),true);
  for(const value of ['',null,undefined,['vision'],{},'../vision','1vision','Vision',' vision','vision/next','a'.repeat(49)])assert.equal(validProject(value),false);
});
test('training pins only a READY immutable release, never latest or the publishing release',()=>{
  const project={project:'vision',state:'PUBLISHING',latestReadyRelease:release,releases:[{release,state:'READY'},{release:future,state:'PUBLISHING'},{release:'latest',state:'READY'},{release,state:'READY'}]};
  assert.deepEqual(readyReleases(project),[{release,state:'READY'}]);
  assert.deepEqual(trainingProject(project,release),{project:'vision',release});
  for(const version of ['latest',future,undefined,''])assert.throws(()=>trainingProject(project,version),/固定版本/);
  assert.deepEqual(trainingProject(null,release),{});
  assert.deepEqual(readyReleases({releases:{release,state:'READY'}}),[]);
  assert.deepEqual(readyReleases({releases:[{release:[release],state:'READY'}]}),[]);
});
test('dataset references survive project-mode training and reject incomplete or path-shaped values',()=>{
  assert.deepEqual(datasetReferences('sample@'+release+'\nother@'+future),[{dataset:'sample',version:release},{dataset:'other',version:future}]);
  assert.deepEqual(datasetReferences(''),[]);
  for(const value of ['sample@latest','../sample@'+release,'sample@'+release+'@extra'])assert.throws(()=>datasetReferences(value));
});
test('project upload chunks share a UUID, exact full-file SHA, length and final fence without truncate',async()=>{
  const bytes=Buffer.alloc(1048576+7,42),file=new Blob([bytes]),calls=[],progress=[];
  await uploadProjectFile(file,{machine:'gpu-1',project:'vision',area:'code',path:'train.py'},async args=>{calls.push(args);return {complete:args.final,size:args.totalSize,sha256:args.sha256};},(offset,total)=>progress.push([offset,total]));
  assert.equal(calls.length,2);assert.match(calls[0].uploadId,/^[a-f0-9-]{36}$/);
  assert.equal(calls[0].uploadId,calls[1].uploadId);assert.equal(calls[0].sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.ok(calls.every(call=>call.totalSize===bytes.length&&call.sha256===calls[0].sha256&&call.project==='vision'&&call.area==='code'&&!Object.hasOwn(call,'truncate')));
  assert.deepEqual(calls.map(call=>[call.offset,call.final]),[[0,false],[1048576,true]]);
  assert.deepEqual(Buffer.concat(calls.map(call=>Buffer.from(call.data,'base64'))),bytes);assert.deepEqual(progress.at(-1),[bytes.length,bytes.length]);
});
test('zero-byte project upload still finalizes; a failed retry uses a fresh upload identity',async()=>{
  const context={machine:'gpu-1',project:'vision',area:'code',path:'empty.txt'},calls=[];
  await assert.rejects(uploadProjectFile(new Blob([]),context,async args=>{calls.push(args);throw Error('mock interrupted');}),/interrupted/);
  await uploadProjectFile(new Blob([]),context,async args=>{calls.push(args);return {complete:true,size:0,sha256:args.sha256};});
  assert.equal(calls.length,2);assert.notEqual(calls[0].uploadId,calls[1].uploadId);
  assert.ok(calls.every(call=>call.final&&call.totalSize===0&&call.offset===0&&call.data===''));
});
test('project upload rejects output writes, oversized files and inconsistent length before any chunk',async()=>{
  let sent=0;const send=async()=>sent++,context={machine:'gpu-1',project:'vision',area:'code',path:'x'};
  await assert.rejects(uploadProjectFile(new Blob(['x']),{...context,area:'output'},send),/代码草稿/);
  await assert.rejects(uploadProjectFile({size:100*1024*1024+1},context,send),/100 MiB/);
  await assert.rejects(uploadProjectFile({size:1,arrayBuffer:async()=>new ArrayBuffer(0)},context,send),/长度/);
  assert.equal(sent,0);
});
test('project upload cannot report success without an exact final verified receipt',async()=>{
  const file=new Blob(['abc']),context={machine:'gpu-1',project:'vision',area:'code',path:'file.txt'},sha256=createHash('sha256').update('abc').digest('hex');
  const valid={complete:true,size:3,sha256};
  for(const receipt of [undefined,null,{}, {...valid,complete:false},{...valid,complete:'true'},{...valid,size:2},{...valid,size:'3'},{...valid,sha256:'f'.repeat(64)}]){
    const progress=[];await assert.rejects(uploadProjectFile(file,context,async()=>receipt,value=>progress.push(value)),/尚未确认完整文件/);
    assert.deepEqual(progress,[],'a rejected final receipt must not announce completed bytes');
  }
});
test('terminal identity carries the selected project but never combines it with host root',()=>{
  assert.deepEqual(terminalContext({machine:'gpu-1',project:'vision'}),{machine:'gpu-1',project:'vision',hostAdmin:false});
  assert.deepEqual(terminalContext({machine:'gpu-1',project:''}),{machine:'gpu-1',hostAdmin:false});
  assert.deepEqual(terminalContext({machine:'gpu-1',hostAdmin:true}),{machine:'gpu-1',hostAdmin:true});
  assert.throws(()=>terminalContext({machine:'gpu-1',project:'vision',hostAdmin:true}),/ROOT/);
  for(const machine of ['',undefined,'auto'])assert.throws(()=>terminalContext({machine}));
  assert.throws(()=>terminalContext({machine:'gpu-1',project:['vision']}));
});
test('project job table preserves full identity and escapes dynamic fields including GPU indices',()=>{
  const html=taskTable([{id:'job" onmouseover="bad',name:'<img src=x>',username:'<owner>',machine:'gpu-1',cards:1,assignedIndices:['<bad>'],state:'SUCCEEDED',project:'<project>',release,error:'<error>'}]);
  assert.doesNotMatch(html,/<img|<owner>|<project>|<bad>|<error>|data-job-output="job" onmouseover=/);
  assert.match(html,/data-job-output=/);assert.ok(html.includes(release));assert.match(html,/取消<\/button>/);
});
