import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cloudImportCall} from '../cloud-import.mjs';
import {runCloudFiles} from '../client-cloud-files.mjs';
import {cloudFilesRows,cloudFilesHTML,cloudFilesUI} from '../dist/cloud-files-ui.js';
const actor={userId:'demo-user-1',username:'member',role:'member'};
function setup(){const calls=[];return {calls,service:{store:{get:()=>({enabled:true,limits:{'gpu-1':1}})},bridge:async(machine,op,args)=>{calls.push({machine,op,args});return {operationId:args.key,state:'QUEUED'};},cloudRates:new Map(),audit(){}}};}
test('member cloud operations force actor identity and bypass no account authority',async()=>{
  const {service,calls}=setup(),key=randomUUID();await cloudImportCall(service,actor,'cloud.files.upload',{machine:'gpu-1',key,path:'incoming/数据.zip'});
  assert.deepEqual(calls[0],{machine:'gpu-1',op:'datasets.cloud.upload',args:{key,path:'incoming/数据.zip',userId:actor.userId,hostAdmin:false}});
  for(const extra of [{hostAdmin:true},{userId:'demo-user-2'},{receipt:'private'},{token:'private'}])await assert.rejects(cloudImportCall(service,actor,'cloud.files.upload',{machine:'gpu-1',key,path:'a',...extra}));
  await assert.rejects(cloudImportCall(service,actor,'cloud.files.list',{machine:'gpu-2'}),e=>e.status===403);
});
test('cloud maintenance gate and revocation check remain active',async()=>{
  const {service,calls}=setup();service.assertMaintenanceAllowed=()=>{throw Error('maintenance');};
  await assert.rejects(cloudImportCall(service,actor,'cloud.files.upload',{machine:'gpu-1',key:randomUUID(),path:'a'}),/maintenance/);assert.equal(calls.length,0);
  delete service.assertMaintenanceAllowed;let count=0;
  await assert.rejects(cloudImportCall(service,actor,'cloud.files.list',{machine:'gpu-1'},()=>{if(++count===2)throw Error('revoked');}),/revoked/);
});
test('CLI upload prints stable operation key and maps server-relative path',async()=>{
  const calls=[],messages=[],key=randomUUID();const r=await runCloudFiles({positionals:['data','cloud','upload','incoming/中文.zip'],options:{key,machines:[],datasets:[]},machine:'gpu-1',stderr:{write:x=>messages.push(x)},call:async(op,args)=>{calls.push({op,args});return {result:{operationId:args.key,state:'QUEUED'}};}});
  assert.equal(r.operationId,key);assert.equal(calls[0].op,'cloud.files.upload');assert.equal(calls[0].args.path,'incoming/中文.zip');assert.match(messages[0],new RegExp(key));
});
test('CLI rejects escape paths, root options and malformed file IDs before call',async()=>{
  for(const [positionals,options] of [[['data','cloud','upload','../x'],{}],[['data','cloud','upload','a'],{root:true}],[['data','cloud','verify','x'],{}],[['data','cloud','list'],{key:randomUUID()}]]){
    let called=false;await assert.rejects(runCloudFiles({positionals,options,machine:'gpu-1',stderr:{write(){}},call:async()=>{called=true;}}));assert.equal(called,false);
  }
});
test('cloud UI escapes names, has a single folded entry and no credential fields',()=>{
  const html=cloudFilesRows([{action:'upload',state:'VERIFIED',operationId:'" onclick="evil',name:'<script>x</script>',bytes:5,totalBytes:5}]);
  assert.doesNotMatch(html,/<script>|" onclick="/);assert.match(html,/&lt;script&gt;/);
  assert.match(cloudFilesHTML(),/<details/);assert.doesNotMatch(cloudFilesHTML(),/name="(?:password|token|account)"/);
});

function uiHarness(call){
  const listeners=new Map(),status={textContent:''},pendingKey={textContent:''},list={innerHTML:'',replaceChildren(){this.innerHTML='';}},machine={value:'gpu-1'},path={value:'incoming/data.zip'},messages=[];
  const section={querySelector:s=>({'#cloud-files-status':status,'#cloud-files-pending-key':pendingKey,'#cloud-files-list':list,'[name=dataset-machine]':machine,'[name=cloud-files-path]':path})[s],addEventListener:(name,callback)=>listeners.set(name,callback)};
  const store={production:true,principal:{userId:'demo-user-1'},authGeneration:1,call};
  const ui=cloudFilesUI(store,section,text=>messages.push(text));
  const submit=()=>listeners.get('submit')({target:{id:'cloud-files-form'},preventDefault(){}});
  const refresh=()=>listeners.get('click')({target:{closest:()=>({id:'cloud-files-refresh',dataset:{}})}});
  return {store,ui,status,pendingKey,list,machine,path,messages,submit,refresh};
}
const drain=()=>new Promise(resolve=>setImmediate(resolve));
test('lost accepted response survives re-login and retries the original key, including 401/403',async()=>{
  for(const code of [401,403]){
    const keys=[];let first=true;
    const h=uiHarness(async(op,args)=>{
      if(op==='cloud.files.upload'){keys.push(args.key);if(first){first=false;throw Object.assign(Error('authorization expired after acceptance'),{status:code});}return {operationId:args.key};}
      if(op==='cloud.files.info')return {enabled:true};
      if(op==='cloud.files.status')throw Object.assign(Error('original operation not found'),{status:404});
      if(op==='cloud.files.list')return {files:[]};
      throw Error('unexpected operation '+op);
    });
    h.submit();await drain();assert.equal(keys.length,1);assert.match(h.status.textContent,/expired/);
    h.store.authGeneration++;h.ui.reset();h.submit();await drain();
    assert.equal(keys.length,2);assert.equal(keys[1],keys[0]);assert.match(h.pendingKey.textContent,new RegExp(keys[0]));assert.match(h.status.textContent,/未确认/);
  }
});
test('unknown operation blocks a different upload and a mismatched status cannot clear it',async()=>{
  const keys=[];const h=uiHarness(async(op,args)=>{
    if(op==='cloud.files.upload'){keys.push(args.key);throw Error('response lost');}
    if(op==='cloud.files.info')return {enabled:true};
    if(op==='cloud.files.status')return {operationId:randomUUID()};
    throw Error('must not list or create a second operation');
  });
  h.submit();await drain();h.path.value='incoming/other.zip';h.submit();await drain();
  assert.equal(keys.length,1);assert.match(h.status.textContent,/未确认/);
  h.refresh();await drain();assert.match(h.status.textContent,/还未确认/);
  h.submit();await drain();assert.equal(keys.length,1);
});
test('old account responses cannot update a newly selected account, or discard its pending operation',async()=>{
  let oldResolve;const calls=[];
  const h=uiHarness(async(op,args)=>{
    calls.push({op,args,user:h.store.principal.userId});
    if(op==='cloud.files.upload'&&h.store.principal.userId==='demo-user-1')return new Promise(resolve=>{oldResolve=resolve;});
    if(op==='cloud.files.upload')throw Error('new account response lost');
    if(op==='cloud.files.status')throw Object.assign(Error('original operation not found'),{status:404});
    throw Error('unexpected operation');
  });
  h.submit();await drain();const oldKey=calls[0].args.key;
  h.store.principal={userId:'demo-user-2'};h.store.authGeneration++;h.ui.reset();h.submit();await drain();
  const newKey=calls[1].args.key;assert.notEqual(oldKey,newKey);const newStatus=h.status.textContent;
  oldResolve({operationId:oldKey});await drain();assert.equal(h.status.textContent,newStatus);
  h.submit();await drain();const writes=calls.filter(row=>row.op==='cloud.files.upload');assert.equal(writes[2].args.key,newKey);
  assert.equal(calls.at(-2).op,'cloud.files.upload');assert.equal(calls.at(-1).op,'cloud.files.status');assert.equal(calls.at(-1).args.operationId,newKey);
});
