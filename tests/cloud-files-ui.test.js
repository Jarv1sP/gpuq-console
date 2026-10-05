// Frontend-only contracts; no cloud provider, node or portal I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {cloudFilesRows,cloudFilesUI} from '../dist/cloud-files-ui.js';

function harness(call){
  const handlers=new Map(),status={textContent:''},list={innerHTML:'',replaceChildren(){this.innerHTML='';}},machine={value:'node-a'};
  const section={querySelector:s=>({'#cloud-files-status':status,'#cloud-files-list':list,'[name=dataset-machine]':machine})[s],addEventListener:(name,fn)=>handlers.set(name,fn)};
  const store={production:true,principal:{userId:'member'},authGeneration:1,call};
  const ui=cloudFilesUI(store,section,()=>{});
  const click=dataset=>handlers.get('click')({target:{closest:()=>({dataset})}});
  return {store,ui,list,status,machine,click};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('verified own files offer reverify as well as restore; pending files keep check action',()=>{
  const id=randomUUID(),verified=cloudFilesRows([{action:'upload',state:'VERIFIED',operationId:id,name:'data.zip'}]);
  assert.match(verified,new RegExp('data-cloud-verify="'+id+'"'));assert.match(verified,/重新校验/);
  assert.match(verified,/data-cloud-restore=/);
  assert.match(cloudFilesRows([{action:'upload',state:'VERIFYING',operationId:id}]),/>检查云端<\/button>/);
});

test('explicit identity change cannot be labelled resumable or offer old operation resume',()=>{
  const id=randomUUID(),html=cloudFilesRows([{action:'download',state:'PAUSED',operationId:id,
    errorCode:'CLOUD_FILE_IDENTITY_CHANGED',canResume:true,error:'private implementation detail'}]);
  assert.match(html,/文件已变化/);assert.match(html,/先重新校验/);assert.match(html,/新的路径/);
  assert.match(html,/原下载和已有文件会保留/);assert.doesNotMatch(html,/可续传|data-cloud-resume|data-cloud-restore|private implementation/);
});

test('normal or unknown pauses do not imply identity change or discard existing resume status',()=>{
  for(const errorCode of [undefined,'NETWORK_UNAVAILABLE','OTHER']){
    const html=cloudFilesRows([{action:'download',state:'PAUSED',operationId:randomUUID(),canResume:true,errorCode,error:'网络中断'}]);
    assert.match(html,/可续传/);assert.match(html,/网络中断/);assert.doesNotMatch(html,/云端文件已变化/);
  }
});

test('reverify uses a fresh UUID after each confirmed operation, never original download/file key',async()=>{
  const fileId=randomUUID(),oldDownloadId=randomUUID(),calls=[];
  const h=harness(async(op,args)=>{
    calls.push({op,args});
    if(op==='cloud.files.verify')return {operationId:args.key,state:'VERIFIED'};
    if(op==='cloud.files.info')return {enabled:true};
    if(op==='cloud.files.list')return {files:[{action:'upload',state:'VERIFIED',operationId:fileId}]};
    throw Error('No download/resume may be triggered by verification');
  });
  h.click({cloudVerify:fileId});await flush();h.click({cloudVerify:fileId});await flush();
  const verifies=calls.filter(c=>c.op==='cloud.files.verify');assert.equal(verifies.length,2);
  assert.notEqual(verifies[0].args.key,verifies[1].args.key);
  for(const {args} of verifies){assert.equal(args.fileId,fileId);assert.equal(args.machine,'node-a');
    assert.notEqual(args.key,fileId);assert.notEqual(args.key,oldDownloadId);assert.match(args.key,/^[a-f0-9-]{36}$/);}
  assert.equal(calls.some(c=>c.op==='cloud.files.download'||c.op.includes('resume')),false);
});

test('lost reverify response retains its original key, without replacing paused download receipt',async()=>{
  const fileId=randomUUID(),calls=[];let first=true;
  const h=harness(async(op,args)=>{
    calls.push({op,args});
    if(op==='cloud.files.verify'){if(first){first=false;throw Error('lost');}return {operationId:args.key};}
    if(op==='cloud.files.info')return {enabled:true};if(op==='cloud.files.list')return {files:[]};
    throw Error('Unexpected operation');
  });
  h.click({cloudVerify:fileId});await flush();h.click({cloudVerify:fileId});await flush();
  const verifies=calls.filter(c=>c.op==='cloud.files.verify');assert.equal(verifies.length,2);
  assert.equal(verifies[0].args.key,verifies[1].args.key);assert.equal(verifies[0].args.fileId,fileId);
  assert.equal(calls.some(c=>c.op==='cloud.files.download'||c.op.includes('resume')),false);
});

test('late reverify reply cannot repaint another account or trigger a download',async()=>{
  let resolve;const calls=[],h=harness(async(op,args)=>{calls.push({op,args});return new Promise(done=>{resolve=done;});});
  h.click({cloudVerify:randomUUID()});await flush();const oldKey=calls[0].args.key;
  h.store.principal={userId:'another'};h.store.authGeneration++;h.ui.reset();h.status.textContent='新账号';
  resolve({operationId:oldKey});await flush();assert.equal(h.status.textContent,'新账号');assert.equal(calls.length,1);
});

test('reverify labels and actions preserve filename escaping',()=>{
  const html=cloudFilesRows([{action:'upload',state:'VERIFIED',operationId:'" onclick="evil',name:'<script>x</script>'}]);
  assert.doesNotMatch(html,/<script>|" onclick="/);assert.match(html,/&lt;script&gt;/);assert.match(html,/重新校验/);
});

test('reader guide separates changed-file recovery from normal same-operation resume',async()=>{
  const guide=await readFile(new URL('../docs/USER_GUIDE.md',import.meta.url),'utf8');
  const chapter=guide.slice(guide.indexOf('### 保存与取回云端副本'),guide.indexOf('### 从云盘或下载链接导入'));
  assert.match(chapter,/点击“重新校验”/);assert.match(chapter,/重新校验对应的云端副本，再取回到新的路径/);
  assert.match(chapter,/旧下载不会自动续传/);assert.match(chapter,/已有文件和临时内容都会保留/);
  assert.match(chapter,/普通连接中断仍按原下载的编号续传/);
});
