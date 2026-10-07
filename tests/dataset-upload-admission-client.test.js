import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {uploadDatasetSnapshot,snapshotKey} from '../client-data-upload.mjs';
import {uploadBrowserDataset,uploadKey} from '../dist/dataset-upload.js';
import {datasetUploadCalls,datasetUploadKeyStore} from '../dist/datasets-ui.js';
import {saveDatasetUploadSession} from '../cli.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const issued='11111111-1111-4111-8111-111111111111',legacyId='22222222-2222-4222-8222-222222222222';
const capability={protocol:1,available:true},machine='gpu-1',name='mine',userId='test-owner';
const rawManifest=Buffer.from(JSON.stringify({schema:1,directories:[],files:[]}));
function snapshot(browser){return {manifest:browser?new Blob([rawManifest]):rawManifest,manifestSha256:hash(rawManifest),totalBytes:0,entries:0,files:[],paths:new Map(),verify:async()=>{}};}
function fixture(browser){
  const scan=snapshot(browser),base=(browser?uploadKey:snapshotKey)(...(browser?[userId,machine,name,scan.manifestSha256]:[[userId,machine,name,scan.manifestSha256]]));
  const intents=new Map(),handles=new Map(),keys=new Map(),calls=[],events=[];
  const store={get:key=>keys.get(key),set:(key,value)=>keys.set(key,value),getIntent:key=>intents.get(key),setIntent:async(key,value)=>{events.push(['save',structuredClone(value)]);intents.set(key,structuredClone(value));},getHandle:key=>handles.get(key),setHandle:(key,value)=>handles.set(key,value)};
  let state='RECEIVING_MANIFEST',offset=0,admitted,loseAdmission=false,loseBegin=false,unconfirmedAdmission=false;
  const spec={name,manifestBytes:rawManifest.length,manifestSha256:scan.manifestSha256,totalBytes:0,entries:0};
  const receipt=()=>({protocol:'dataset-upload-admission-v1',key:base,uploadId:issued,requestedMachine:machine,storageMachine:'warehouse',storageTier:'hdd',specification:spec,state:'ISSUED'});
  const result=(id=issued)=>({uploadId:id,name,state,manifestOffset:offset,manifestBytes:rawManifest.length,totalBytes:0,entries:0,placementProtocol:1,requestedMachine:machine,storageMachine:'warehouse',storageTier:'hdd',legacyPlacement:false,...(state==='READY'?{dataset:'u-test-mine',version:hash(rawManifest)}:{})});
  const directCall=async(operation,args)=>{
    calls.push({operation,args});events.push(['call',operation]);
    if(operation==='datasets.upload.admission.create'){
      assert.deepEqual(intents.get(base),{protocol:1,userId,machine,key:base,specification:spec});
      assert.deepEqual(args,{machine,key:base,...spec});admitted=receipt();
      if(loseAdmission){loseAdmission=false;throw Object.assign(Error('lost admission ACK'),{status:503});}
      return admitted;
    }
    if(operation==='datasets.upload.admission.status'){
      assert.deepEqual(args,{machine,key:base});if(unconfirmedAdmission||!admitted)throw Error('admission unknown');return admitted;
    }
    const action=operation.slice('datasets.upload.'.length);
    if(action==='begin'){
      assert.equal(args.key,intents.get(base)?.uploadId||keys.get(base)||base);
      if(intents.has(base)){assert.equal(intents.get(base).beginAttempted,true);assert.equal(args.key,issued);}
      if(loseBegin){loseBegin=false;throw Object.assign(Error('lost begin ACK'),{status:504});}
      return result(keys.has(base)?legacyId:issued);
    }
    assert.equal(args.machine,machine);assert.ok([issued,legacyId].includes(args.uploadId));
    if(action==='manifest'){assert.equal(args.offset,offset);offset+=Buffer.from(args.data,'base64').length;return {offset};}
    if(action==='seal'){state='UPLOADING';return result(args.uploadId);}
    if(action==='commit'){state='READY';return result(args.uploadId);}
    if(action==='status')return result(args.uploadId);
    throw Error('Unexpected operation '+operation);
  };
  const options={machine,name,userId,scan,keyStore:store,admission:capability};
  const run=(extra={})=>browser?uploadBrowserDataset({...options,call:directCall,pollMs:0,...extra}):uploadDatasetSnapshot(async(op,args)=>({result:await (extra.call||directCall)(op,args)}),{...options,progress:()=>{},...extra});
  return {browser,base,scan,spec,store,intents,handles,keys,calls,events,receipt,result,directCall,run,setState:v=>{state=v;},loseAdmission:()=>{loseAdmission=true;},loseBegin:()=>{loseBegin=true;},unknownAdmission:()=>{unconfirmedAdmission=true;}};
}

for(const browser of [false,true]){
  const client=browser?'browser':'CLI core';
  test(`${client}: persist intent and server UUID before begin, complete upload, restart only original status`,async()=>{
    const f=fixture(browser);assert.equal((await f.run()).state,'READY');
    assert.equal(f.calls[0].operation,'datasets.upload.admission.create');assert.equal(f.calls[1].operation,'datasets.upload.begin');
    assert.notEqual(f.calls[1].args.key,f.base);assert.equal(f.calls[1].args.key,issued);
    assert.deepEqual(f.events.slice(0,5).map(row=>row[0]),['save','call','save','save','call']);
    const at=f.calls.length;assert.equal((await f.run()).uploadId,issued);
    assert.ok(f.calls.slice(at).every(row=>row.operation==='datasets.upload.status'));assert.equal(f.intents.size,1);
  });
  test(`${client}: lost admission ACK queries original intent and can continue after its receipt is confirmed`,async()=>{
    const f=fixture(browser);f.loseAdmission();assert.equal((await f.run()).state,'READY');
    assert.deepEqual(f.calls.slice(0,3).map(row=>row.operation),['datasets.upload.admission.create','datasets.upload.admission.status','datasets.upload.begin']);
    assert.equal(f.calls[1].args.key,f.base);assert.equal(f.calls[2].args.key,issued);
  });
  test(`${client}: unknown admission stops, restart never repeats create or invents a new intent`,async()=>{
    const f=fixture(browser);f.loseAdmission();f.unknownAdmission();await assert.rejects(f.run(),/admission unknown/);
    assert.deepEqual(f.calls.map(row=>row.operation),['datasets.upload.admission.create','datasets.upload.admission.status']);
    const before=structuredClone(f.intents.get(f.base));await assert.rejects(f.run(),/admission unknown/);
    assert.equal(f.calls.at(-1).operation,'datasets.upload.admission.status');assert.deepEqual(f.intents.get(f.base),before);
  });
  test(`${client}: initial, assigned-UUID and begin-attempt persistence failures all refuse begin`,async()=>{
    for(const failAt of [1,2,3]){
      const f=fixture(browser),save=f.store.setIntent;let count=0;
      f.store.setIntent=async(...args)=>{if(++count===failAt)throw Object.assign(Error('durable storage failed'),{code:'PERSISTENCE'});return save(...args);};
      await assert.rejects(f.run(),/durable storage failed/);assert.equal(f.calls.some(row=>row.operation==='datasets.upload.begin'),false);
      assert.equal(f.calls.length,failAt===1?0:1);
    }
    const f=fixture(browser);f.store.setIntent=()=>{};await assert.rejects(f.run(),/保存未确认/);assert.equal(f.calls.length,0);
  });
  test(`${client}: lost begin ACK queries exactly the issued UUID and never repeats begin`,async()=>{
    const f=fixture(browser);f.setState('READY');f.loseBegin();assert.equal((await f.run()).state,'READY');
    assert.deepEqual(f.calls.slice(0,3).map(row=>row.operation),['datasets.upload.admission.create','datasets.upload.begin','datasets.upload.status']);
    assert.equal(f.calls[2].args.uploadId,issued);assert.equal(f.calls.filter(row=>row.operation==='datasets.upload.begin').length,1);
  });
  test(`${client}: partial lost begin ACK stops, explicit resume first reads original UUID then restores the same begin identity`,async()=>{
    const f=fixture(browser);f.loseBegin();await assert.rejects(f.run(),/初始化未确认|initialization receipt was lost/);
    assert.deepEqual(f.calls.map(row=>row.operation),['datasets.upload.admission.create','datasets.upload.begin','datasets.upload.status']);
    const before=f.calls.length;assert.equal((await f.run()).state,'READY');
    assert.deepEqual(f.calls.slice(before,before+2).map(row=>row.operation),['datasets.upload.status','datasets.upload.begin']);
    assert.equal(f.calls.at(before).args.uploadId,issued);assert.equal(f.calls.at(before+1).args.key,issued);
    assert.equal(f.calls.filter(row=>row.operation==='datasets.upload.admission.create').length,1);
  });
  test(`${client}: full specification, target and account changes refuse a cached intent before any call`,async()=>{
    for(const field of ['name','manifestBytes','manifestSha256','totalBytes','entries','machine','userId']){
      const f=fixture(browser),intent={protocol:1,userId,machine,key:f.base,specification:{...f.spec}};
      if(field in intent.specification)intent.specification[field]=typeof intent.specification[field]==='number'?intent.specification[field]+1:'other';else intent[field]='other';
      f.intents.set(f.base,intent);await assert.rejects(f.run(),/清单不符/);assert.equal(f.calls.length,0);
    }
  });
  test(`${client}: incorrect admission receipt or begin identity refuses all upload bytes`,async()=>{
    for(const patch of [{key:legacyId},{uploadId:'not-a-uuid'},{requestedMachine:'other'},{storageTier:'existing'},{state:'UNKNOWN'},{specification:{}}]){
      const f=fixture(browser),call=async(op,args)=>op==='datasets.upload.admission.create'?{...await f.directCall(op,args),...patch}:f.directCall(op,args);
      await assert.rejects(f.run(browser?{admissionCall:call}:{call}),/准入/);
      assert.equal(f.calls.some(row=>row.operation==='datasets.upload.begin'),false);
    }
    for(const patch of [{uploadId:legacyId},{name:'other'},{manifestBytes:1},{totalBytes:1},{entries:1}]){
      const f=fixture(browser),call=async(op,args)=>{const value=await f.directCall(op,args);return op==='datasets.upload.begin'?{...value,...patch}:value;};
      if(browser)await assert.rejects(f.run({call}),patch.uploadId?/准入不符|会话与/:/上传结果与本地清单不符/);
      else await assert.rejects(uploadDatasetSnapshot(async(op,args)=>({result:await call(op,args)}),{machine,name,userId,scan:f.scan,keyStore:f.store,admission:capability,progress:()=>{}}),/saved warehouse admission/);
      assert.equal(f.calls.some(row=>row.operation==='datasets.upload.manifest'),false);
    }
  });
  test(`${client}: old Portal and disabled policy reject new uploads without any RPC, old stored key still resumes`,async()=>{
    for(const admission of [undefined,{}, {protocol:1,available:false},{protocol:0,available:true}]){
      const f=fixture(browser);await assert.rejects(f.run({admission}),/准入未启用/);assert.equal(f.calls.length,0);
    }
    const f=fixture(browser);f.keys.set(f.base,legacyId);f.setState('READY');assert.equal((await f.run({admission:undefined})).uploadId,legacyId);
    assert.equal(f.calls[0].operation,'datasets.upload.begin');assert.equal(f.calls.some(row=>row.operation.includes('.admission.')),false);
  });
  test(`${client}: legacy handle including unresolved LOCATING never allocates a fresh admission`,async()=>{
    const f=fixture(browser);f.handles.set(f.base,{uploadId:legacyId,machine,name,manifestSha256:f.scan.manifestSha256,totalBytes:0,entries:0,state:'LOCATING'});
    const call=async(op,args)=>{f.calls.push({operation:op,args});assert.equal(op,'datasets.upload.status');assert.equal(args.uploadId,legacyId);throw Error('legacy location unresolved');};
    if(browser)await assert.rejects(f.run({call,admission:undefined}),/legacy location unresolved/);
    else await assert.rejects(uploadDatasetSnapshot(async(op,args)=>({result:await call(op,args)}),{machine,name,userId,scan:f.scan,keyStore:f.store,progress:()=>{}}),/legacy location unresolved/);
    assert.equal(f.calls.length,1);assert.equal(f.intents.size,0);
  });
  test(`${client}: issued discarded upload is terminal and does not rotate UUID`,async()=>{
    const f=fixture(browser);f.setState('DISCARDED');await assert.rejects(f.run(),/取消|discarded/);
    assert.equal(f.calls.filter(row=>row.operation==='datasets.upload.admission.create').length,1);assert.equal(f.calls.filter(row=>row.operation==='datasets.upload.begin').length,1);assert.equal(f.intents.get(f.base).uploadId,issued);
  });
}

test('browser storage errors/corrupt cache refuse new intent; modern calls bypass transfers while old key retains original adapter',async()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},store=datasetUploadKeyStore(storage),f=fixture(true);
  const directCall=async(op,args)=>{assert.equal(op.startsWith('transfers.'),false);const saved=store.getIntent(f.base);if(saved)f.intents.set(f.base,saved);return f.directCall(op,args);};
  const calls=datasetUploadCalls(directCall,store,f.base,{version:1});assert.equal(calls.call,directCall);assert.equal(calls.admissionCall,directCall);
  assert.equal((await f.run({...calls,keyStore:store})).state,'READY');
  const original=f.calls.length;assert.equal((await f.run({...datasetUploadCalls(directCall,store,f.base,{version:1}),keyStore:store})).state,'READY');assert.ok(f.calls.slice(original).every(row=>row.operation==='datasets.upload.status'));
  const legacy='old-base';store.set(legacy,legacyId);const translated=[];
  const old=datasetUploadCalls(async(op,args)=>{translated.push({op,args});return {id:'old-transfer',uploadId:legacyId,result:{state:'READY',uploadId:legacyId}};},store,legacy,{version:1});
  await old.call('datasets.upload.begin',{machine,name,key:legacyId});assert.equal(translated[0].op,'transfers.create');assert.equal(translated[0].args.key,legacyId);
  assert.throws(()=>datasetUploadKeyStore({getItem(){throw Error('blocked');}}).getIntent(f.base),/无法读取/);
  assert.throws(()=>datasetUploadKeyStore({getItem(){return null;},setItem(){throw Error('quota');}}).setIntent(f.base,{}),/无法保存/);
  values.set('gpuq.dataset-upload.intent.'+f.base,'broken');assert.throws(()=>store.getIntent(f.base),/损坏/);
  const other=uploadKey('other-user',machine,name,f.scan.manifestSha256);assert.notEqual(other,f.base);assert.equal(store.getIntent(other),null);
});

test('CLI session persistence is atomic, synced and refuses unsafe cache links',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dataset-admission-cache-')),path=join(dir,'session.json');t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path,'{"old":true}',{mode:0o600});await saveDatasetUploadSession(path,{datasetUploadIntents:{one:{protocol:1,uploadId:issued}}});
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{datasetUploadIntents:{one:{protocol:1,uploadId:issued}}});
  const link=join(dir,'link');await symlink(path,link);await assert.rejects(saveDatasetUploadSession(link,{}),/Unsafe/);
});

test('standalone CLI uses real durable intent and issued UUID, then resumes lost begin ACK with only original status',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dataset-admission-cli-')),session=join(dir,'session.json'),data=join(dir,'data');await mkdir(data);let intentKey,spec,state='RECEIVING_MANIFEST',offset=0,loseBegin=true;const calls=[];
  const server=createServer(async(req,res)=>{try{
    let raw='';for await(const part of req)raw+=part;const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});res.setHeader('Content-Type','application/json');
    if(operation==='state'){res.end(JSON.stringify({state:{demo:false,gpuqConnected:true,machines:[{id:machine}],datasetUploadAdmission:capability}}));return;}
    const saved=JSON.parse(await readFile(session,'utf8'));
    if(operation==='datasets.upload.admission.create'){
      intentKey=args.key;spec=Object.fromEntries(['name','manifestBytes','manifestSha256','totalBytes','entries'].map(key=>[key,args[key]]));assert.equal(saved.datasetUploadIntents[intentKey].key,intentKey);
      res.end(JSON.stringify({result:{protocol:'dataset-upload-admission-v1',key:intentKey,uploadId:issued,requestedMachine:machine,storageMachine:'warehouse',storageTier:'hdd',specification:spec,state:'ISSUED'}}));return;
    }
    const common=()=>({uploadId:issued,state,name,manifestOffset:offset,manifestBytes:spec.manifestBytes,totalBytes:0,entries:0,placementProtocol:1,requestedMachine:machine,storageMachine:'warehouse',storageTier:'hdd',legacyPlacement:false,...(state==='READY'?{dataset:'u-test-mine',version:spec.manifestSha256}:{})});
    const action=operation.slice('datasets.upload.'.length);let result;
    if(action==='begin'){assert.equal(args.key,issued);assert.equal(saved.datasetUploadIntents[intentKey].uploadId,issued);assert.equal(saved.datasetUploadIntents[intentKey].beginAttempted,true);if(loseBegin){loseBegin=false;req.socket.destroy();return;}result=common();}
    else {assert.equal(args.uploadId,issued);if(action==='status')result=common();else if(action==='manifest'){offset+=Buffer.from(args.data,'base64').length;result={offset};}else if(action==='seal'){state='UPLOADING';result=common();}else if(action==='commit'){state='READY';result=common();}else throw Error(operation);}
    res.end(JSON.stringify({result}));
  }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;await writeFile(session,JSON.stringify({url,token:'test-only',principal:{userId},machine}),{mode:0o600});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const cli=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--url',url,'--session-file',session,'--json','data','upload',data,'--name',name]);let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
  const first=await cli();assert.equal(first.code,1,first.stderr);assert.match(first.stderr,/initialization receipt was lost/);
  assert.deepEqual(calls.slice(1,4).map(row=>row.operation),['datasets.upload.admission.create','datasets.upload.begin','datasets.upload.status']);
  const before=calls.length,second=await cli();assert.equal(second.code,0,second.stderr);assert.equal(JSON.parse(second.stdout).data.uploadId,issued);assert.deepEqual(calls.slice(before,before+3).map(row=>row.operation),['state','datasets.upload.status','datasets.upload.begin']);
  const completed=calls.length,third=await cli();assert.equal(third.code,0,third.stderr);assert.deepEqual(calls.slice(completed).map(row=>row.operation),['state','datasets.upload.status']);
});
