// True Portal/SQLite/cookies, downloaded bundled CLI, Chromium and local files.
// Bridge/storage are disposable in-memory fixtures; no SSH, GPUs or production.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import net from 'node:net';
import {createServer as createHTTPS} from 'node:https';
import {testTLSIdentity} from './campus-upload-fixture.mjs';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {installDatasetIngress} from '../dataset-ingress.mjs';
import {installStorageArchive} from '../storage-archive.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),password='Transfer-HTTP-Browser-Fixture-2026!';
const dir=await mkdtemp(join(tmpdir(),'gpuq-transfer-http-ui-')),reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
let server,service,browser,directServer,directOrigin;const tls=testTLSIdentity(),directBytes=[];const calls=[],publicCalls=[],receipts=new Map(),uploads=new Map(),errors=[];
const warehousePolicy={enabled:true,machine:'gpu-4',authority:'hdd'};
const requestContext=new AsyncLocalStorage();
const assertBridgeIdentity=(call,memberId)=>{
  if(call.op==='datasets.list')assert.deepEqual(call.args,{userId:'builtin-admin',hostAdmin:true},'fixed metadata list uses only the exact service identity');
  else if(call.op==='datasets.capacity'&&call.args.userId==='builtin-admin'){
    assert.equal(call.request?.operation,'datasets.overview','service capacity requires an actual overview request in this call chain');
    assert.equal(call.request?.userId,memberId,'overview belongs to the authenticated member in this session');
    assert.deepEqual(call.args,{userId:'builtin-admin',hostAdmin:true},'overview capacity uses only the exact service identity and no extra arguments');
  }else{
    assert.equal(call.args.userId,memberId,`${call.op} derives identity from authenticated owner`);
    assert.equal(call.args.hostAdmin??false,false,`${call.op} never inherits metadata administrative authority`);
  }
};
const data=Buffer.alloc(2*1024**2+13,17),manifest=Buffer.from(JSON.stringify({directories:[],files:[{path:'train.bin',sha256:hash(data),size:data.length}],schema:1})),version=hash(manifest),info={state:'READY',manifestBytes:manifest.length,manifestSha256:version,totalBytes:data.length,entries:1};
try{
  const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const uploadView=u=>({uploadId:u.id,name:u.spec.name,state:u.state,manifestOffset:u.manifest.length,manifestBytes:u.spec.manifestBytes,totalBytes:u.spec.totalBytes,entries:u.spec.entries,chunkBytes:1024**2,remainingBytes:u.spec.totalBytes-[...u.files.values()].reduce((n,b)=>n+b.length,0),...(u.state==='READY'?{dataset:'u-'+hash(u.owner).slice(0,16)+'-'+u.spec.name,version:hash(u.manifest)}:{})});
  const bridge=async(machine,op,args)=>{
    calls.push({machine,op,args,request:requestContext.getStore()});
    if(op==='transfers.source.prepare')return {id:args.id,token:'x'.repeat(43),...info};
    if(op==='transfers.start'){if(!receipts.has(args.id))receipts.set(args.id,{id:args.id,state:'RUNNING',bytes:123,totalBytes:data.length});return receipts.get(args.id);}
    if(op==='transfers.cancel'){receipts.get(args.id).state='CANCELED';return receipts.get(args.id);}
    if(op==='transfers.status'||op==='transfers.resume')return receipts.get(args.id);
    if(op==='datasets.snapshot.info')return info;
    if(op==='datasets.snapshot.manifest'||op==='datasets.snapshot.get'){const bytes=op.endsWith('manifest')?manifest:data,part=bytes.subarray(args.offset,args.offset+1024**2);return {data:part.toString('base64'),offset:args.offset+part.length,size:bytes.length,eof:args.offset+part.length===bytes.length};}
    if(op==='datasets.list')return {datasets:[]};
    if(op==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:20*1024**3,usableBytes:492*1024**3,totalInodes:100000,availableInodes:50000,inodeUsageKnown:true,guarded:true};
    if(op==='datasets.upload.routes'){
      assert.equal(machine,warehousePolicy.machine);assert.equal(args.uploadId,undefined);
      return {available:true,protocol:'dataset-upload-v1',machine,revision:'a'.repeat(64),certificateSha256:tls.pin,routes:[{id:'primary',kind:'campus-direct',endpoint:directOrigin}]};
    }
    if(op==='storage.upload.admit'){
      assert.equal(machine,warehousePolicy.machine);assert.equal(args.protocol,'dataset-upload-admission-v1');
      assert.equal(args.hostAdmin,false);assert.equal(args.requestedMachine,'gpu-1');
      assert.equal(args.storageMachine,machine);assert.equal(args.authority,'hdd');
      assert.match(args.uploadId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.notEqual(args.uploadId,args.intentKey);assert.equal(args.specificationSha256,hash(JSON.stringify(args.specification)));
      const mapping=service.db.prepare('SELECT upload_id FROM dataset_upload_admissions WHERE owner=? AND intent_key=?').get(args.userId,args.intentKey);
      assert.equal(mapping.upload_id,args.uploadId,'server UUID is durably issued before the node RPC');
      const placement=JSON.parse(service.db.prepare('SELECT data FROM dataset_upload_placements WHERE owner=? AND upload_id=?').get(args.userId,args.uploadId).data);
      assert.equal(placement.phase,'BOUND');assert.deepEqual(placement.specification,args.specification);
      assert.equal(placement.storageMachine,machine);assert.equal(placement.requestedMachine,args.requestedMachine);
      assert.equal(uploads.has(args.uploadId),false,'fresh admission cannot reuse a legacy session');
      const u={id:args.uploadId,owner:args.userId,machine,admitted:true,admissionKey:args.intentKey,requestedMachine:args.requestedMachine,authority:args.authority,state:'RECEIVING_MANIFEST',spec:args.specification,manifest:Buffer.alloc(0),files:new Map()};
      uploads.set(u.id,u);
      return {...uploadView(u),admissionProtocol:1,admissionKey:args.intentKey,machine,authority:'hdd',
        uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true}};
    }
    if(op==='storage.upload.locate'){
      const u=uploads.get(args.uploadId);assert(u?.admitted);assert.equal(machine,u.machine);assert.equal(args.userId,u.owner);assert.equal(Object.hasOwn(args,'hostAdmin'),false);
      return {protocol:'dataset-upload-location-v1',machine,userId:u.owner,uploadId:u.id,present:true,nodePresent:true,uploadAdmissionProtocol:1,initializationProtocol:1,state:u.state,specification:u.spec,
        admissionProtocol:1,admissionKey:u.admissionKey,requestedMachine:u.requestedMachine,storageMachine:u.machine,admissionAuthority:u.authority,authority:{enabled:true,machine:u.machine,authority:u.authority}};
    }
    if(op==='datasets.upload.begin'){
      assert.equal(service.datasetIngressPolicy.enabled,false,'only the independent legacy transfer phase may issue bare begin');
      if(!uploads.has(args.key))uploads.set(args.key,{id:args.key,owner:args.userId,state:'RECEIVING_MANIFEST',spec:args,manifest:Buffer.alloc(0),files:new Map()});
      return {...uploadView(uploads.get(args.key)),uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true}};
    }
    if(op.startsWith('datasets.upload.')){
      const u=uploads.get(args.uploadId),action=op.split('.').at(-1);assert.ok(u);
      assert.equal(args.userId,u.owner);if(u.admitted)assert.equal(machine,u.machine,'modern control and bytes remain on the fixed HDD');
      if(action==='direct-ticket')return {available:true,kind:'campus-direct',protocol:'dataset-upload-v1',machine,endpoint:directOrigin,ticket:'fixture-campus-ticket-'+u.id,expiresAt:Math.floor(Date.now()/1000)+300,certificateSha256:tls.pin,chunkBytes:1024**2};
      if(['manifest','chunk'].includes(action))assert.equal(requestContext.getStore()?.channel,'campus-direct','Raw file bytes cannot come from Portal or transfers.io');
      if(action==='manifest'){const part=Buffer.from(args.data,'base64');assert.equal(args.offset,u.manifest.length);u.manifest=Buffer.concat([u.manifest,part]);return {...uploadView(u),offset:u.manifest.length};}
      if(action==='seal'){assert.equal(u.manifest.length,u.spec.manifestBytes);assert.equal(hash(u.manifest),u.spec.manifestSha256);u.state='UPLOADING';u.entries=JSON.parse(u.manifest).files;assert.equal(u.entries.reduce((n,f)=>n+f.size,0),u.spec.totalBytes);assert.equal(u.entries.length+JSON.parse(u.manifest).directories.length,u.spec.entries);return uploadView(u);}
      if(action==='status'){const result=uploadView(u);if(args.path){const entry=u.entries.find(f=>f.path===args.path),bytes=u.files.get(args.path);result.file={...entry,offset:bytes?.length||0,complete:bytes!==undefined&&bytes.length===entry.size};}return result;}
      if(action==='chunk'){const before=u.files.get(args.path)||Buffer.alloc(0),part=Buffer.from(args.data,'base64');assert.equal(before.length,args.offset);u.files.set(args.path,Buffer.concat([before,part]));return {...uploadView(u),offset:before.length+part.length,complete:true};}
      if(action==='commit'){for(const entry of u.entries)assert.equal(hash(u.files.get(entry.path)),entry.sha256);u.state='READY';return uploadView(u);}
      if(action==='pause')return uploadView(u);
    }throw Error('Unexpected bridge operation '+op);
  };
  directServer=createHTTPS({key:tls.key,cert:tls.cert},async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Content-Type','application/json');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    try{
      const url=new URL(req.url,directOrigin);
      if(url.pathname==='/capabilities'){res.end(JSON.stringify({protocol:'dataset-upload-v1',machine:warehousePolicy.machine,revision:'a'.repeat(64),listenerReady:true}));return;}
      const [,,,uploadId,action]=url.pathname.split('/'),u=uploads.get(uploadId);
      assert.ok(u);assert.ok(['manifest','chunk','status'].includes(action));assert.equal(req.headers.authorization,'Bearer fixture-campus-ticket-'+u.id);assert.equal(req.headers.cookie,undefined);
      const parts=[];for await(const bytes of req)parts.push(bytes);const bytes=Buffer.concat(parts);
      const args={userId:u.owner,hostAdmin:false,uploadId,...(url.searchParams.has('path')?{path:url.searchParams.get('path')}:{}),...(action!=='status'?{offset:Number(url.searchParams.get('offset')),data:bytes.toString('base64')}:{})};
      directBytes.push({uploadId,action,length:bytes.length,owner:u.owner});
      const result=await requestContext.run({operation:'datasets.upload.'+action,userId:u.owner,channel:'campus-direct'},()=>bridge(u.machine||'gpu-1','datasets.upload.'+action,args));
      res.end(JSON.stringify({ok:true,result}));
    }catch(error){errors.push(error.message);res.statusCode=400;res.end(JSON.stringify({ok:false}));}
  });
  await new Promise(resolve=>directServer.listen(0,'127.0.0.1',resolve));directOrigin='https://127.0.0.1:'+directServer.address().port;
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge,directUploadOrigins:[directOrigin]}));
  // Observe the authenticated Portal call, not a flag that a later request could
  // retroactively apply to unrelated capacity reads. Never retain the token.
  for(const method of ['invoke','datasetRead']){
    const original=service[method].bind(service);
    service[method]=(token,operation,...args)=>{
      const request={operation,userId:service.principal(token).userId};
      if(method==='invoke')publicCalls.push({...request,args:structuredClone(args[0])});
      return requestContext.run(request,()=>original(token,operation,...args));
    };
  }
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'transfer-member',password})).result;await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});const login=await service.login(member.username,password),session=join(dir,'session.json');await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal,machine:'gpu-1'}));
  const cliFile=join(dir,'gpuctl.mjs');await writeFile(cliFile,await (await fetch(origin+'/gpuctl.mjs')).text());
  const cli=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cliFile,'--session-file',session,'--json',...args]);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',code=>{if(code)reject(Error(err));else resolve(JSON.parse(out).data);});child.stdin.end();});
  await mkdir(join(dir,'local'));await writeFile(join(dir,'local/train.bin'),data);const uploaded=await cli(['transfer','upload',join(dir,'local'),'--name','cli-data']);assert.ok(uploaded.transferId);assert.equal(uploaded.state,'READY');assert.equal((await cli(['transfer','status',uploaded.transferId])).state,'SUCCEEDED');
  const download=await cli(['transfer','download','shared@'+version,join(dir,'download')]);assert.deepEqual(await readFile(join(dir,'download/train.bin')),data);assert.equal(download.state,'SUCCEEDED');
  const copied=await cli(['transfer','copy','shared@'+version,'--from','gpu-1','--to','gpu-2','--name','cli-copy','--detach']);assert.equal(copied.state,'RUNNING');assert.equal((await cli(['transfer','cancel',copied.id])).state,'CANCELED');assert.equal((await cli(['transfer','list'])).transfers.length,3);
  // The legacy managed-transfer workflow above remains independent. The real
  // trusted installers now expose modern admission for the browser dataset API.
  installStorageArchive(service,warehousePolicy,{startTimer:false});installDatasetIngress(service,warehousePolicy);
  assert.deepEqual((await service.invoke(login.token,'state',{})).state.datasetUploadAdmission,{protocol:1,available:true,targetMachine:warehousePolicy.machine});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  const openTransfers=async()=>{const entry=page.locator('#warehouse-page-actions a[href="#datasets/transfers"]');assert.equal(await entry.textContent(),'传输记录');await entry.click();await page.locator('#page-transfers').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>location.hash),'#datasets/transfers');};
  await page.goto(origin);await page.locator('#login-form [name=username]').fill(member.username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=datasets]').click();await openTransfers();await page.locator('#transfer-copy > summary').click();await page.locator('#transfer-copy-form').waitFor();
  await page.locator('#transfer-copy-form [name=transfer-from]').selectOption('gpu-1');await page.locator('#transfer-copy-form [name=transfer-machine]').selectOption('gpu-2');await page.locator('#transfer-copy-form [name=transfer-reference]').fill('shared@'+version);await page.locator('#transfer-copy-form [name=transfer-name]').fill('browser-copy');await page.locator('#transfer-copy-form [type=submit]').click();await page.locator('#transfer-list article').filter({hasText:'browser-copy'}).waitFor();
  const entry=page.locator('#transfer-list article').filter({hasText:'browser-copy'});await entry.locator('[data-transfer-action=status]').click();page.once('dialog',d=>d.accept());await entry.locator('[data-transfer-action=cancel]').click();await entry.filter({hasText:'CANCELED'}).waitFor();
  const browserUploadStart=publicCalls.length,bridgeUploadStart=calls.length;
  await page.locator('[data-nav=datasets]').click();await page.locator('#warehouse-page-actions [data-v3-upload]').click();await page.locator('[name=dataset-directory]').setInputFiles(join(dir,'local'));await page.locator('#v3-upload-display').fill('browser-upload');await page.waitForFunction(()=>document.querySelector('#v3-upload-route').classList.contains('ok')).catch(async error=>{throw Error(error.message+' '+JSON.stringify({route:await page.locator('#v3-upload-route').textContent(),failures:errors,operations:publicCalls.slice(browserUploadStart).map(row=>row.operation)}));});await page.locator('#dataset-upload-start').click();await page.locator('#dataset-upload-status[data-state=READY]').waitFor({state:'attached'}).catch(async error=>{console.error('UPLOAD DIAGNOSTIC',JSON.stringify({status:await page.locator('#dataset-upload-status').textContent(),errors,operations:publicCalls.slice(browserUploadStart).map(row=>row.operation)}));throw error;});
  assert.match(await page.locator('#dataset-upload-status').textContent(),/可用于训练/);assert.equal(await page.locator('#v3-upload-state .v3-done>b').textContent(),'browser-upload');assert.equal(await page.locator('#v3-upload-state [data-use-dataset]').isEnabled(),true);
  const uploadedReference=await page.locator('#v3-upload-state [data-use-dataset]').evaluate(node=>({dataset:node.dataset.useDataset,version:node.dataset.version}));
  const browserUpload=[...uploads.values()].find(value=>value.spec.name==='data-'+hash(Buffer.from('browser-upload')).slice(0,24));assert.ok(browserUpload);assert.equal(browserUpload.state,'READY');assert.equal(uploadedReference.version,hash(browserUpload.manifest));
  const browserManifest=JSON.parse(browserUpload.manifest);assert.equal(browserManifest.files.length,1);assert.equal(browserManifest.files[0].sha256,hash(data));assert.equal(browserManifest.files[0].size,data.length);assert.deepEqual(browserUpload.files.get(browserManifest.files[0].path),data);
  assert.ok(directBytes.some(row=>row.uploadId===browserUpload.id&&row.action==='chunk'&&row.length>0),'Browser bytes use the independent HTTPS endpoint');
  // The legacy download above still reads its fixed snapshot through Portal.
  // Its manifest read is distinct from an upload manifest write, and remains
  // an explicitly unconverted product path. All upload bytes must use TLS.
  assert.equal(publicCalls.some(row=>['datasets.upload.manifest','datasets.upload.chunk'].includes(row.operation)||row.operation==='transfers.io'&&(row.args.action==='chunk'||row.args.action==='manifest'&&row.args.id!==download.transferId)),false,'Neither modern nor managed uploads send bytes through Portal');
  assert.equal(publicCalls.some(row=>row.operation==='transfers.io'&&Object.hasOwn(row.args,'data')),false,'No transfer control call contains upload payload');
  assert.ok(publicCalls.some(row=>row.operation==='transfers.io'&&row.args.action==='manifest'&&row.args.id===download.transferId),'The original legacy download is still exercised separately');
  const managedUpload=[...uploads.values()].find(value=>value.spec.name==='cli-data');assert.ok(managedUpload);
  assert.ok(directBytes.some(row=>row.uploadId===managedUpload.id&&row.action==='chunk'&&row.length>0),'Managed CLI upload bytes also use the independent HTTPS endpoint');
  const modernCalls=publicCalls.slice(browserUploadStart),issued=modernCalls.filter(call=>call.operation==='datasets.upload.admission.create'),begun=modernCalls.filter(call=>call.operation==='datasets.upload.begin');
  assert.equal(issued.length,1);assert.equal(begun.length,1);assert.notEqual(issued[0].args.key,begun[0].args.key);assert.equal(begun[0].args.key,browserUpload.id);
  assert.deepEqual(Object.fromEntries(['name','manifestBytes','manifestSha256','totalBytes','entries'].map(key=>[key,begun[0].args[key]])),browserUpload.spec);
  assert.equal(modernCalls.some(call=>call.operation==='transfers.io'||call.operation==='transfers.create'&&call.args.kind==='upload'),false,'modern datasets never create or proxy a managed transfer');
  const modernBridge=calls.slice(bridgeUploadStart).filter(call=>call.op==='storage.upload.admit'||call.op.startsWith('datasets.upload.')&&call.op!=='datasets.upload.routes');
  assert.equal(modernBridge[0].op,'storage.upload.admit');assert.equal(modernBridge.filter(call=>call.op==='storage.upload.admit').length,1);
  assert.ok(modernBridge.every(call=>call.machine===warehousePolicy.machine&&(call.args.uploadId===browserUpload.id)),'all modern controls and bytes use the fixed HDD and issued UUID');
  assert.equal(modernBridge.some(call=>call.op==='datasets.upload.begin'),false,'no bare node begin bypasses private admission');
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem('gpuq.dataset-upload.intent.'+key)),issued[0].args.key);
  assert.deepEqual(saved,{protocol:1,userId:member.id,machine:'gpu-1',key:issued[0].args.key,specification:browserUpload.spec,uploadId:browserUpload.id,storageMachine:warehousePolicy.machine,storageTier:'hdd',beginAttempted:true});
  assert.equal((await service.invoke(login.token,'datasets.upload.status',{machine:'gpu-1',uploadId:browserUpload.id})).result.state,'READY');
  await page.locator('[data-dataset-add-close]').click();await page.locator('[data-nav=datasets]').click();await openTransfers();await page.locator('#transfer-refresh').click();
  const browserTransfer=page.locator('#transfer-list article').filter({hasText:browserUpload.spec.name});assert.equal(await browserTransfer.count(),0,'modern dataset uploads are not synthetic transfer records');
  assert.match(await page.locator('#transfer-list article').filter({hasText:'cli-data'}).textContent(),/已完成/);
  assert.equal((await cli(['transfer','list'])).transfers.length,4,'only three CLI transfers and the real browser copy exist');
  const capture=async name=>{if(process.env.UI_SCREENSHOTS){await mkdir(process.env.UI_SCREENSHOTS,{recursive:true});await page.waitForFunction(()=>!document.querySelector('#toast')?.classList.contains('visible'));await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:join(process.env.UI_SCREENSHOTS,name+'.png'),animations:'disabled'});}};
  await capture('transfers-desktop');
  const markedRoute=await page.evaluate(()=>{
    document.querySelector('[data-nav=work]').click();location.hash='transfers';dispatchEvent(new HashChangeEvent('hashchange'));
    return ['#page-transfers','.page-heading'].every(selector=>document.querySelector(selector).classList.contains('desktop-route-slide'));
  });
  assert.ok(markedRoute,'the shell identifies only its desktop route slides');
  await page.evaluate(()=>{for(const animation of document.getAnimations())animation.cancel();});
  await page.evaluate(()=>{}); // Drain completion handlers before holding a frame.
  const desktopIndicator=await page.locator('.nav-indicator').evaluate(el=>({left:el.style.left,top:el.style.top,width:el.style.width,height:el.style.height}));
  const mobileFit=async width=>{
    await page.setViewportSize({width,height:844});
    // A viewport can become mobile before resize listeners cancel a desktop
    // transition. Hold that exact first frame instead of relying on CI timing.
    await page.evaluate(geometry=>{
      globalThis.heldDesktopTransitions=['#page-transfers','.page-heading'].map(selector=>{
        const target=document.querySelector(selector);target.classList.add('desktop-route-slide');
        const animation=target.animate([{opacity:0,transform:'translateX(24px)'},{opacity:1,transform:'none'}],{duration:280,fill:'both'});
        animation.pause();animation.currentTime=0;return animation;
      });
      const indicator=document.querySelector('.nav-indicator');Object.assign(indicator.style,geometry);indicator.hidden=false;
    },desktopIndicator);
    const layout=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,
      roomTransform:getComputedStyle(document.querySelector('#page-transfers')).transform,
      headingTransform:getComputedStyle(document.querySelector('.page-heading')).transform,
      indicatorDisplay:getComputedStyle(document.querySelector('.nav-indicator')).display,
      heroRight:document.querySelector('.transfer-group.hero-frame').getBoundingClientRect().right}));
    assert.ok(layout.document<=width+1,`transfer page overflows ${width}px before resize cleanup: ${JSON.stringify(layout)}`);
    assert.equal(layout.roomTransform,'none','mobile room never retains a desktop slide');
    assert.equal(layout.headingTransform,'none','mobile heading never retains a desktop slide');
    assert.equal(layout.indicatorDisplay,'none','mobile navigation ignores stale desktop indicator geometry');
    await page.evaluate(()=>{for(const animation of globalThis.heldDesktopTransitions){animation.effect.target.classList.remove('desktop-route-slide');animation.cancel();}delete globalThis.heldDesktopTransitions;document.querySelector('.nav-indicator').hidden=true;});
  };
  await mobileFit(390);assert.deepEqual(errors,[]);
  assert.ok(calls.some(call=>call.op==='datasets.list'),'catalog exercises the fixed metadata discovery operation');
  assert.ok(calls.some(call=>call.op==='datasets.capacity'&&call.args.userId==='builtin-admin'&&call.request?.operation==='datasets.overview'),'browser really requests the overview service capacity read');
  for(const call of calls){
    assert.equal(call.request?.userId,member.id,`${call.op} originates from the authenticated member request`);
    assertBridgeIdentity(call,member.id);
  }
  const overview={operation:'datasets.overview',userId:member.id},capacity={op:'datasets.capacity',args:{userId:'builtin-admin',hostAdmin:true},request:overview};
  assertBridgeIdentity(capacity,member.id);
  for(const denied of [
    {...capacity,request:undefined},
    {...capacity,request:{...overview,operation:'datasets.capacity'}},
    {...capacity,request:{...overview,userId:'another-member'}},
    {...capacity,args:{userId:'builtin-admin',hostAdmin:false}},
    {...capacity,args:{...capacity.args,path:'/not-permitted'}},
    {...capacity,args:{userId:member.id,hostAdmin:true}},
    {...capacity,op:'datasets.snapshot.get'},
    {...capacity,op:'datasets.upload.begin'},
  ])assert.throws(()=>assertBridgeIdentity(denied,member.id),assert.AssertionError);
  for(const request of [undefined,overview]){
    assertBridgeIdentity({op:'datasets.capacity',args:{userId:member.id,hostAdmin:false},request},member.id);
  }
  assert.equal(service.store.jobs.length,0);
  await capture('transfers-mobile');
  await mobileFit(320);
  assert.equal(await page.locator('#transfer-copy-form input,#transfer-copy-form select').evaluateAll(items=>items.every(el=>parseFloat(getComputedStyle(el).fontSize)>=16)),true,'mobile transfer fields avoid zoom');
  await capture('transfers-320');
  console.log('Transfers HTTP/CLI/Chromium passed: upload, download bytes, background copy, list/status/cancel, shared browser upload, mobile and owner isolation.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));else service?.close();if(directServer)await new Promise(r=>directServer.close(r));await rm(dir,{recursive:true,force:true});}

// Exercise grouped presentation and mission-control records in the same CI entry.
await import('./transfers-panel-fixture.mjs');
await import('./navigation-browser-fixture.mjs');
await import('./attention-ui-smoke.mjs');
