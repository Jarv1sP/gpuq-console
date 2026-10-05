// Frontend contracts, with no cloud account, node or production request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudImportHTML,cloudImportUI,shareCapability} from '../dist/cloud-import-ui.js';

function harness(t,respond){
  const listeners=new Map(),calls=[],messages=[];
  const nodes={'#cloud-import-status':{textContent:''},'#cloud-auth-status':{textContent:''},'#cloud-import-list':{innerHTML:'',replaceChildren(){this.innerHTML='';}},'[name=dataset-machine]':{value:'node-a'},'[name=cloud-source]':{value:'https'},'[name=cloud-url]':{value:'https://cdn.example.test/file.zip?signature=private'},'[name=cloud-path]':{value:'incoming/original.zip'},'[name=cloud-sha256]':{value:''},'[name=cloud-file]':{value:'file-a',innerHTML:''},'[name=cloud-password]':{value:''},'#cloud-auth-qr':{hidden:true},'#cloud-auth-check':{hidden:true}};
  const store={production:true,principal:{userId:'alice',role:'member'},authGeneration:1,async call(op,args){calls.push({op,args:structuredClone(args),user:this.principal.userId});return respond(op,args,this);}};
  const section={querySelector:s=>nodes[s],querySelectorAll:()=>[],addEventListener:(name,callback)=>listeners.set(name,callback)};
  const ui=cloudImportUI(store,section,message=>messages.push(message));t.after(()=>ui.reset());
  const click=id=>listeners.get('click')({target:{closest:()=>({dataset:{},id})}});
  const change=(name,value)=>{nodes['[name='+name+']'].value=value;listeners.get('change')({target:{name,value}});};
  const submit=()=>listeners.get('submit')({target:{id:'cloud-import-form',dataset:{}},preventDefault(){}});
  return {store,ui,nodes,calls,messages,click,change,submit};
}
const drain=()=>new Promise(resolve=>setImmediate(resolve));
const absent=()=>{throw Object.assign(Error('original operation absent'),{status:404});};

test('share capability requires an explicit verified fact; login and nodeDirect do not prove it',()=>{
  for(const info of [undefined,null,{}, {aliyunConnected:true,nodeDirect:true},{capabilityVerified:'true'},{capabilityVerified:false},{capabilityVerified:true,disabled:true},{capabilityVerified:true,configurationEnabled:false}])assert.equal(shareCapability(info),false);
  assert.equal(shareCapability({capabilityVerified:true}),true);
});

test('HTTPS is independent and default; native admin QR remains present while members never see it',()=>{
  const member=cloudImportHTML(),admin=cloudImportHTML(true);
  assert.match(member,/<select name="cloud-source"><option value="https">/);
  assert.doesNotMatch(member,/cloud-admin|cloud-auth-begin|cloud-auth-qr/);
  assert.match(admin,/id="cloud-auth-begin"/);assert.match(admin,/id="cloud-auth-qr"/);
});

test('unverified shares never inspect or start, even when logged in and nodeDirect is true',async t=>{
  for(const info of [null,{}, {aliyunConnected:true,nodeDirect:true,capabilityVerified:false}]){
    const h=harness(t,async op=>{assert.equal(op,'cloud.info');return info;});
    h.change('cloud-source','aliyun');await drain();await h.click('cloud-inspect');h.submit();await drain();
    assert.deepEqual(h.calls.map(c=>c.op),['cloud.info']);assert.match(h.nodes['#cloud-import-status'].textContent,/暂不可用/);
    h.change('cloud-source','https');await drain();assert.equal(h.calls.length,1,'source changes do not probe a provider');
  }
});

test('lost accepted import replies query the original ID and never replay start',async t=>{
  let key;const h=harness(t,async(op,args)=>{
    if(op==='cloud.import.start'){key=args.key;throw Error('reply lost');}
    if(op==='cloud.import.status'){assert.equal(args.operationId,key);return {operationId:key,state:'QUEUED'};}
    assert.equal(op,'cloud.import.list');return {imports:[]};
  });
  h.submit();await drain();assert.deepEqual(h.calls.map(c=>c.op),['cloud.import.start','cloud.import.status','cloud.import.list']);
  assert.equal(h.nodes['#cloud-import-status'].textContent,'准备中');assert.equal(h.calls.filter(c=>c.op==='cloud.import.start').length,1);
});

test('retry queries first; only authoritative 404 reuses the exact frozen request',async t=>{
  let attempts=0;const h=harness(t,async(op,args)=>{
    if(op==='cloud.import.start'){if(++attempts===1)throw Error('lost');return {operationId:args.key,state:'QUEUED'};}
    if(op==='cloud.import.status')return absent();
    assert.equal(op,'cloud.import.list');return {imports:[]};
  });
  h.submit();await drain();const original=h.calls[0].args;
  h.nodes['[name=cloud-path]'].value='incoming/edited.zip';h.nodes['[name=cloud-url]'].value='https://cdn.example.test/other.zip';await h.click('cloud-import-retry');
  assert.deepEqual(h.calls.slice(0,4).map(c=>c.op),['cloud.import.start','cloud.import.status','cloud.import.status','cloud.import.start']);
  assert.equal(h.calls[2].args.operationId,original.key);assert.deepEqual(h.calls[3].args,original);
});

test('network and authorization status errors never replay an uncertain import',async t=>{
  for(const status of [401,403,429,503]){
    const h=harness(t,async op=>{if(op==='cloud.import.start')throw Error('lost');assert.equal(op,'cloud.import.status');throw Object.assign(Error('status unavailable'),{status});});
    h.submit();await drain();await h.click('cloud-import-retry');assert.equal(h.calls.filter(c=>c.op==='cloud.import.start').length,1);
  }
});

test('an explicitly retried share is still gated if capability was withdrawn',async t=>{
  let verified=true;const h=harness(t,async(op,args)=>{
    if(op==='cloud.info')return {capabilityVerified:verified};
    if(op==='cloud.inspect')return {inspectionId:'local-share',files:[{id:'file-a',name:'shared.zip',size:1024}]};
    if(op==='cloud.import.status')return absent();
    assert.equal(op,'cloud.import.start');throw Error('lost reply');
  });
  h.change('cloud-source','aliyun');await drain();await h.click('cloud-inspect');h.submit();await drain();verified=false;await h.click('cloud-import-retry');
  assert.equal(h.calls.filter(c=>c.op==='cloud.import.start').length,1);assert.match(h.nodes['#cloud-import-status'].textContent,/暂不可用/);
});

test('missing, unknown or foreign receipts cannot confirm an import or trigger retry',async t=>{
  for(const state of [undefined,'UNKNOWN','FUTURE'])for(const foreign of [false,true]){
    let key;const h=harness(t,async(op,args)=>{if(op==='cloud.import.start')key=args.key;assert(['cloud.import.start','cloud.import.status'].includes(op));return {operationId:foreign?'another-operation':key,state};});
    h.submit();await drain();await h.click('cloud-import-retry');assert.equal(h.calls.filter(c=>c.op==='cloud.import.start').length,1);assert.match(h.nodes['#cloud-import-status'].textContent,/未确认/);
  }
});

test('malformed lists stay unconfirmed and UNKNOWN rows cannot release a pending request',async t=>{
  let key,malformed=true;const h=harness(t,async(op,args)=>{
    if(op==='cloud.info')return {capabilityVerified:false};
    if(op==='cloud.import.start'){key=args.key;throw Error('lost');}
    if(op==='cloud.import.status')return {operationId:key,state:'UNKNOWN'};
    assert.equal(op,'cloud.import.list');return malformed?{}:{imports:[{operationId:key,state:'UNKNOWN',path:'incoming/original.zip'}]};
  });
  h.submit();await drain();await h.click('cloud-import-refresh');assert.match(h.nodes['#cloud-import-status'].textContent,/列表未确认/);assert.doesNotMatch(h.nodes['#cloud-import-list'].innerHTML,/暂无导入/);
  malformed=false;await h.click('cloud-import-refresh');h.submit();await drain();assert.equal(h.calls.filter(c=>c.op==='cloud.import.start').length,1);assert.match(h.nodes['#cloud-import-status'].textContent,/核对未确认/);
});

test('native administrator QR still works without verified share capability',async t=>{
  const h=harness(t,async op=>{
    if(op==='cloud.info')return {backend:'aliyun',aliyunConnected:true,capabilityVerified:false};
    assert.equal(op,'cloud.auth.begin');return {id:'local-qr',image:'data:image/svg+xml,'};
  });
  h.store.principal.role='admin';await h.click('cloud-auth-begin');
  assert.deepEqual(h.calls.map(c=>c.op),['cloud.info','cloud.auth.begin']);assert.equal(h.nodes['#cloud-auth-qr'].hidden,false);
});

test('HTTPS progress reads never depend on cloud login or share metadata',async t=>{
  const h=harness(t,async op=>{assert.equal(op,'cloud.import.list');return {imports:[]};});
  await h.click('cloud-import-refresh');assert.deepEqual(h.calls.map(c=>c.op),['cloud.import.list']);assert.match(h.nodes['#cloud-import-list'].innerHTML,/暂无导入/);
});

test('externally managed backend never sends unsupported QR begin',async t=>{
  const h=harness(t,async op=>{assert.equal(op,'cloud.info');return {managedExternally:true,capabilityVerified:false};});
  h.store.principal.role='admin';await h.click('cloud-auth-begin');assert.equal(h.calls.length,1);assert.equal(h.nodes['#cloud-auth-status'].textContent,'云盘连接由后台管理。');
});

test('zero authorization blocks imports even for an administrator',async t=>{
  for(const role of ['member','admin']){
    const h=harness(t,()=>assert.fail('unauthorized API request'));h.store.principal.role=role;h.store.data={users:[{id:'alice',enabled:true,limits:{'node-a':0}}]};
    await h.click('cloud-import-refresh');h.submit();await drain();assert.equal(h.calls.length,0);assert.match(h.nodes['#cloud-import-status'].textContent,/未授权/);
  }
});

test('late receipts do not query or paint under a different account',async t=>{
  let finish;const h=harness(t,async()=>new Promise(resolve=>{finish=resolve;}));h.submit();await drain();const key=h.calls[0].args.key;
  h.store.principal={userId:'bob',role:'member'};h.store.authGeneration++;h.ui.reset();h.nodes['#cloud-import-status'].textContent='bob current view';finish({operationId:key,state:'READY'});await drain();
  assert.equal(h.calls.length,1);assert.equal(h.nodes['#cloud-import-status'].textContent,'bob current view');assert.equal(h.nodes['#cloud-import-list'].innerHTML,'');
});
