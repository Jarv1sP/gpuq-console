// Frontend contracts only; no real cloud account, node, or Portal is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cloudFilesHTML,cloudFilesRows,cloudFilesUI} from '../dist/cloud-files-ui.js';

function harness(respond){
  const listeners=new Map(),calls=[],messages=[];
  const nodes={'#cloud-files-status':{textContent:''},'#cloud-files-pending-key':{textContent:''},'#cloud-files-list':{innerHTML:'',replaceChildren(){this.innerHTML='';}},'[name=dataset-machine]':{value:'node-a'},'[name=cloud-files-path]':{value:'incoming/data.zip'}};
  const store={production:true,principal:{userId:'alice',role:'member'},authGeneration:1,async call(op,args){calls.push({op,args:structuredClone(args),user:this.principal.userId});return respond(op,args,this);}};
  const section={querySelector:s=>nodes[s],addEventListener:(name,callback)=>listeners.set(name,callback)};
  const ui=cloudFilesUI(store,section,message=>messages.push(message));
  const click=(dataset={},id)=>listeners.get('click')({target:{closest:()=>({dataset,id})}});
  const submit=()=>listeners.get('submit')({target:{id:'cloud-files-form'},preventDefault(){}});
  return {store,ui,nodes,calls,messages,click,submit,refresh:()=>click({},'cloud-files-refresh'),retry:()=>click({},'cloud-files-retry')};
}
const drain=()=>new Promise(resolve=>setImmediate(resolve));
const absent=()=>{throw Object.assign(Error('original operation not found'),{status:404});};

test('queued, running, verifying and unknown are not reliable copies; only VERIFIED permits restore',()=>{
  for(const state of ['QUEUED','RUNNING','VERIFYING','UNKNOWN','READY']){
    const html=cloudFilesRows([{operationId:randomUUID(),action:'upload',state}]);
    assert.doesNotMatch(html,/data-cloud-restore=/);
  }
  assert.match(cloudFilesRows([{operationId:randomUUID(),action:'upload',state:'VERIFIED'}]),/data-cloud-restore=/);
  assert.match(cloudFilesRows([{operationId:randomUUID(),state:'UNRECOGNIZED'}]),/状态未确认/);
});

test('only a RUNNING transfer shows progress; verified and other states show the file size',()=>{
  const row={operationId:randomUUID(),action:'upload',bytes:0,totalBytes:4*1024**2};
  assert.match(cloudFilesRows([{...row,state:'RUNNING'}]),/>0\.0 \/ 4\.0 MiB</);
  for(const state of ['QUEUED','VERIFYING','VERIFIED','READY','PAUSED','FAILED','UNKNOWN']){
    const html=cloudFilesRows([{...row,state}]);assert.match(html,/>4\.0 MiB</);assert.doesNotMatch(html,/0\.0 \/ 4\.0/);
  }
});

test('server-file copy has no computer file picker, account, token, or upload-to-cloud promise',()=>{
  const html=cloudFilesHTML();assert.match(html,/把服务器上的个人文件存一份到云端/);
  assert.doesNotMatch(html,/type="file"|电脑直传云盘|name="(?:token|password|account)"/);
});

test('enabled=false is a disabled service, never an empty file list',async()=>{
  const h=harness(async op=>{assert.equal(op,'cloud.files.info');return {enabled:false};});
  await h.refresh();assert.equal(h.calls.length,1);assert.equal(h.nodes['#cloud-files-status'].textContent,'这台服务器未开启云端文件');
  h.submit();await drain();assert.equal(h.calls.length,1);assert.match(h.nodes['#cloud-files-status'].textContent,/未开启/);
});

test('missing or nonboolean enabled and malformed lists stay unconfirmed',async()=>{
  for(const info of [{},{enabled:'true'},{enabled:null}]){
    const h=harness(async op=>{assert.equal(op,'cloud.files.info');return info;});await h.refresh();assert.match(h.nodes['#cloud-files-status'].textContent,/未确认/);assert.equal(h.calls.length,1);
  }
  const h=harness(async op=>op==='cloud.files.info'?{enabled:true}:{});await h.refresh();assert.match(h.nodes['#cloud-files-status'].textContent,/列表未确认/);assert.doesNotMatch(h.nodes['#cloud-files-status'].textContent,/还没有/);
});

test('lost upload reply immediately queries its original ID, without starting a second transfer',async()=>{
  let key;const h=harness(async(op,args)=>{
    if(op==='cloud.files.upload'){key=args.key;throw Error('response lost');}
    assert.equal(op,'cloud.files.status');assert.equal(args.operationId,key);return {operationId:key,action:'upload',path:'incoming/data.zip',state:'QUEUED'};
  });
  h.submit();await drain();assert.deepEqual(h.calls.map(row=>row.op),['cloud.files.upload','cloud.files.status']);
  assert.match(h.nodes['#cloud-files-status'].textContent,/等待传输/);assert.doesNotMatch(h.nodes['#cloud-files-status'].textContent,/已在云端确认|完成/);
});

test('explicit retry first queries status, then retains the original key and frozen file path',async()=>{
  let attempts=0;const h=harness(async(op,args)=>{
    if(op==='cloud.files.upload'){attempts++;if(attempts===1)throw Error('response lost');return {operationId:args.key,state:'UNKNOWN'};}
    assert.equal(op,'cloud.files.status');return absent();
  });
  h.submit();await drain();const original=h.calls[0].args;
  h.nodes['[name=cloud-files-path]'].value='incoming/another.zip';await h.retry();
  const writes=h.calls.filter(row=>row.op==='cloud.files.upload');assert.equal(writes.length,2);assert.deepEqual(writes[1].args,original);
  assert.equal(h.calls[2].op,'cloud.files.status');assert.equal(h.calls[2].args.operationId,original.key);
  assert.match(h.nodes['#cloud-files-status'].textContent,/未确认/);assert.equal(h.nodes['#cloud-files-pending-key'].textContent,original.key);
});

test('HTTP success with missing or UNKNOWN state never completes or blindly replays an operation',async()=>{
  for(const state of [undefined,'UNKNOWN']){
    let key;const h=harness(async(op,args)=>{if(op==='cloud.files.upload'){key=args.key;return {operationId:key,state};}assert.equal(op,'cloud.files.status');return {operationId:key,state};});
    h.submit();await drain();await h.retry();assert.equal(h.calls.filter(row=>row.op==='cloud.files.upload').length,1);assert.match(h.nodes['#cloud-files-status'].textContent,/未确认/);
  }
});

test('normal download resume verifies source and keeps original key, fileId and destination',async()=>{
  const fileId=randomUUID(),key=randomUUID(),path='restored/original.zip';
  const original={operationId:key,action:'download',fileId,path,state:'PAUSED',canResume:true};
  const h=harness(async(op,args)=>{
    if(op==='cloud.files.info')return {enabled:true};
    if(op==='cloud.files.list')return {files:[original]};
    if(op==='cloud.files.status')return args.operationId===key?original:{operationId:fileId,action:'upload',state:'VERIFIED'};
    assert.equal(op,'cloud.files.download');assert.deepEqual(args,{machine:'node-a',key,fileId,path});return {...original,state:'QUEUED'};
  });
  await h.refresh();assert.match(h.nodes['#cloud-files-list'].innerHTML,/data-cloud-resume=/);await h.click({cloudResume:key});
  assert.deepEqual(h.calls.slice(2,5).map(row=>row.op),['cloud.files.status','cloud.files.status','cloud.files.download']);
  assert.equal(h.calls[2].args.operationId,key);assert.equal(h.calls[3].args.operationId,fileId);
  assert.equal(h.calls.filter(row=>row.op==='cloud.files.download').length,1);
});

test('resume cannot rebind a destination or download a VERIFYING source',async()=>{
  for(const mismatch of [false,true]){
    const fileId=randomUUID(),key=randomUUID(),original={operationId:key,action:'download',fileId,path:'restored/original.zip',state:'PAUSED',canResume:true};
    const h=harness(async(op,args)=>{
      if(op==='cloud.files.info')return {enabled:true};if(op==='cloud.files.list')return {files:[original]};
      assert.equal(op,'cloud.files.status');return args.operationId===key?{...original,path:mismatch?'restored/changed.zip':original.path}:{operationId:fileId,action:'upload',state:'VERIFYING'};
    });
    await h.refresh();await h.click({cloudResume:key});assert.equal(h.calls.some(row=>row.op==='cloud.files.download'),false);assert.match(h.nodes['#cloud-files-status'].textContent,/未确认|尚未确认/);
  }
});

test('authorization failures during original-ID queries never replay an upload',async()=>{
  for(const status of [401,403,503]){
    const h=harness(async op=>{if(op==='cloud.files.upload')throw Error('lost response');assert.equal(op,'cloud.files.status');throw Object.assign(Error('not authorized or unavailable'),{status});});
    h.submit();await drain();await h.retry();assert.equal(h.calls.filter(row=>row.op==='cloud.files.upload').length,1);assert.match(h.nodes['#cloud-files-status'].textContent,/还未确认/);
  }
});

test('zero machine authorization denies reads and writes even for an administrator',async()=>{
  for(const role of ['member','admin']){
    const h=harness(()=>assert.fail('zero-authorization request reached the API'));
    h.store.principal.role=role;h.store.data={users:[{id:'alice',enabled:true,limits:{'node-a':0}}]};
    await h.refresh();h.submit();await drain();assert.equal(h.calls.length,0);assert.match(h.nodes['#cloud-files-status'].textContent,/未授权/);
  }
});

test('a late response cannot repaint or query through another account',async()=>{
  let finish;const h=harness(async()=>new Promise(resolve=>{finish=resolve;}));h.submit();await drain();const key=h.calls[0].args.key;
  h.store.principal={userId:'bob',role:'member'};h.store.authGeneration++;h.ui.reset();h.nodes['#cloud-files-status'].textContent='bob current view';
  finish({operationId:key,state:'VERIFIED',action:'upload'});await drain();assert.equal(h.calls.length,1);assert.equal(h.nodes['#cloud-files-status'].textContent,'bob current view');assert.equal(h.nodes['#cloud-files-list'].innerHTML,'');
});

test('unsafe and oversized UTF-8 relative paths never reach the cloud API',async()=>{
  for(const path of ['../x','/x','a//b','a\\b','a\u0000b','汉'.repeat(256),Array(10).fill('汉'.repeat(50)).join('/')]){
    const h=harness(()=>assert.fail('invalid path reached the API'));h.nodes['[name=cloud-files-path]'].value=path;h.submit();await drain();assert.equal(h.calls.length,0);assert.match(h.nodes['#cloud-files-status'].textContent,/相对文件路径/);
  }
});
