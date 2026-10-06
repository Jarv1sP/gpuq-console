import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const VERSION='a'.repeat(64),OPERATION='b'.repeat(64),password='Unregister-Fixture-Password-2026!';
async function apiFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-unregister-api-'));
  const bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  const calls=[];let failure=null,response={operationId:OPERATION,dataset:'sample',version:null,state:'UNREGISTERING'};
  const s=await PortalService.open(join(dir,'database'),bootstrap,status,async(machine,operation,args)=>{
    // Legacy assertions below count actual unregister/status side effects.
    // The safety capability is a separate read and never claims deletion.
    if(operation==='storage.dataset-delete.capabilities')return {protocol:'dataset-delete-node-v1',machine,datasetDelete:1};
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='datasets.list')return {datasets:[{dataset:'sample',versions:[{version:VERSION,state:'READY'}]}]};
    if(operation==='datasets.status'&&calls.some(call=>call.operation==='datasets.unregister'))return {operationId:OPERATION,dataset:'sample',version:null,state:'FAILED'};
    if(failure)throw failure;
    return structuredClone(response);
  });
  clearInterval(s.executionTimer);
  const admin=await s.login('admin',password);
  const user=(await s.invoke(admin.token,'users.create',{username:'member',password})).result;
  await s.invoke(admin.token,'policy.full',{userId:user.id,policyVersion:0});
  const member=await s.login('member',password);
  t.after(async()=>{s.close();await rm(dir,{recursive:true,force:true});});
  return {s,admin,member,calls,fail:value=>failure=value,respond:value=>response=value};
}

test('whole-dataset unregister requires authenticated admin despite full member GPU grants',async t=>{
  const f=await apiFixture(t);
  for(const token of [f.member.token,'invalid'])await assert.rejects(f.s.invoke(token,'datasets.unregister',{machine:'gpu-1',dataset:'sample'}),e=>[401,403].includes(e.status));
  assert.equal(f.calls.length,0);
});

test('missing/old/wrong-machine/failed capability cannot erase an unproven last copy, member or full deletion',async t=>{
  const f=await apiFixture(t),bridge=f.s.bridge,machine=MACHINES[0].id,reads=[];
  for(const capability of [undefined,{protocol:'dataset-delete-node-v1',machine,datasetDelete:0},
    {protocol:'dataset-delete-node-v0',machine,datasetDelete:1},
    {protocol:'dataset-delete-node-v1',machine:'wrong',datasetDelete:1},Error('capability query failed')]){
    f.s.bridge=async(host,operation,args)=>{
      if(operation==='datasets.list'){
        f.calls.push({machine:host,operation,args:structuredClone(args)});
        return {datasets:host===machine?[{dataset:'sample',versions:[{version:VERSION,state:'READY'}]}]:[]};
      }
      if(operation!=='storage.dataset-delete.capabilities')return bridge(host,operation,args);
      reads.push({machine:host,operation,args:structuredClone(args)});
      if(capability instanceof Error)throw capability;
      return structuredClone(capability);
    };
    // Only the target has a full copy. The shared M2 guard must read the whole
    // trusted inventory, then refuse without dispatching or persisting intent.
    for(const extra of [{},{version:null},{version:VERSION}]){
      f.calls.length=0;reads.length=0;
      await assert.rejects(f.s.invoke(f.admin.token,'datasets.unregister',{machine,dataset:'sample',...extra}),
        e=>e.status===409&&e.code==='LAST_COPY_UNPROVEN');
      assert.equal(f.calls.filter(c=>c.operation==='datasets.unregister').length,0);
      assert.deepEqual(f.calls.map(c=>c.machine),MACHINES.map(m=>m.id));
      assert.ok(f.calls.every(c=>c.operation==='datasets.list'&&c.args.userId==='builtin-admin'&&c.args.hostAdmin===true));
      assert.equal(f.s.db.prepare('SELECT count(*) n FROM dataset_removal_exclusions').get().n,0);
      assert.deepEqual(reads,[{machine,operation:'storage.dataset-delete.capabilities',args:{userId:'builtin-admin',hostAdmin:true}}]);
    }
    f.calls.length=0;reads.length=0;
    await assert.rejects(f.s.invoke(f.member.token,'datasets.unregister',{machine,dataset:'sample',version:VERSION}),e=>e.status===409);
    assert.deepEqual(f.calls,[]);assert.equal(reads.length,1);
    for(const token of [f.admin.token,f.member.token]){
      reads.length=0;
      await assert.rejects(f.s.invoke(token,'datasets.delete',{dataset:'sample',version:VERSION,key:randomUUID()}),e=>e.status===409&&e.code==='DATASET_DELETE_UNSUPPORTED');
      assert.deepEqual(f.calls,[]);assert.equal(reads.length,MACHINES.length);
    }
    assert.equal(f.s.db.prepare('SELECT count(*) n FROM dataset_deletions').get().n,0);
    assert.equal(f.s.db.prepare('SELECT count(*) n FROM dataset_deletion_fences').get().n,0);
  }
  assert.equal(f.s.store.jobs.length,0);
});

test('SF3 cap1 removal uses a protocol tag so rolled back legacy executors reject it',async t=>{
  const f=await apiFixture(t),machine=MACHINES[0].id;
  await f.s.invoke(f.member.token,'datasets.unregister',{machine,dataset:'sample',version:VERSION});
  assert.deepEqual(f.calls.at(-1),{machine,operation:'datasets.unregister',args:{dataset:'sample',version:VERSION,userId:f.member.principal.userId,hostAdmin:false,protocol:'dataset-delete-node-v1'}});
});

test('SF8 cap1 admin removal uses real M2 proof and persists exclusions before sending only proved versions',async t=>{
  const f=await apiFixture(t),machine=MACHINES[0].id,bridge=f.s.bridge;
  f.s.bridge=async(host,op,args)=>{
    if(op==='datasets.unregister'){
      const rows=f.s.db.prepare('SELECT * FROM dataset_removal_exclusions').all();
      assert.equal(rows.length,1);assert.equal(rows[0].version,VERSION);assert.equal(rows[0].operation_id,null);
      assert.deepEqual(args.portalProvedOtherCopy,{protocol:'dataset-portal-copy-proof-v1',versions:[VERSION]});
      assert.equal(args.protocol,'dataset-delete-node-v1');
    }
    return bridge(host,op,args);
  };
  await f.s.invoke(f.admin.token,'datasets.unregister',{machine,dataset:'sample',version:VERSION});
  assert.deepEqual(f.calls.filter(c=>c.operation==='datasets.list').map(c=>c.machine),MACHINES.map(m=>m.id));
  assert.equal(f.calls.filter(c=>c.operation==='datasets.unregister').length,1);
});

test('SF4 portal deletion fence refusal before removal dispatch leaves no M2 exclusion, including a late claim',async t=>{
  for(const late of [false,true]){
    const f=await apiFixture(t),machine=MACHINES[0].id,bridge=f.s.bridge;
    let claimed=false;
    const claim=()=>{if(claimed)return;claimed=true;f.s.db.prepare('INSERT INTO dataset_deletion_fences VALUES(?,?,?,?)').run(machine,'sample',VERSION,randomUUID());};
    f.s.bridge=async(host,op,args)=>{
      if(op==='storage.dataset-delete.capabilities')return {protocol:'dataset-delete-node-v1',machine:host,datasetDelete:0};
      if(late&&op==='datasets.list'&&host===MACHINES.at(-1).id)claim();
      return bridge(host,op,args);
    };
    if(!late)claim();
    await assert.rejects(f.s.invoke(f.admin.token,'datasets.unregister',{machine,dataset:'sample',version:VERSION}),e=>e.status===409&&e.code==='DATASET_DELETION_FENCED');
    assert.equal(f.calls.filter(c=>c.operation==='datasets.unregister').length,0);
    if(f.s.db.prepare("SELECT 1 FROM sqlite_master WHERE name='dataset_removal_exclusions'").get())
      assert.deepEqual(f.s.db.prepare('SELECT * FROM dataset_removal_exclusions').all(),[]);
  }
});

test('member version forwards only authenticated identity; node still proves personal provenance',async t=>{
  const f=await apiFixture(t),machine=MACHINES[0].id;
  await f.s.invoke(f.member.token,'datasets.unregister',{machine,dataset:'sample',version:VERSION});
  assert.deepEqual(f.calls.at(-1),{machine,operation:'datasets.unregister',args:{dataset:'sample',version:VERSION,userId:f.member.principal.userId,hostAdmin:false,protocol:'dataset-delete-node-v1'}});
  assert.equal(f.calls.length,1,'a v1 member removal must use the node protection, not the admin-only legacy guard');
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='dataset_removal_exclusions'").get().n,0);
});

test('cap0 admin uses the real shared protected-removal lane and unchanged main request for every capability fallback',async t=>{
  const machine=MACHINES[0].id;
  for(const capability of [undefined,{protocol:'dataset-delete-node-v1',machine,datasetDelete:0},
    {protocol:'dataset-delete-node-v0',machine,datasetDelete:1},
    {protocol:'dataset-delete-node-v1',machine:'wrong',datasetDelete:1},Error('capability query failed')]){
    const f=await apiFixture(t),bridge=f.s.bridge,reads=[];let receipt;
    f.s.bridge=async(host,operation,args)=>{
      if(operation==='storage.dataset-delete.capabilities'){
        reads.push({machine:host,operation,args:structuredClone(args)});
        if(capability instanceof Error)throw capability;
        return structuredClone(capability);
      }
      if(operation==='datasets.status'){
        f.calls.push({machine:host,operation,args:structuredClone(args)});
        assert.equal(args.operationId,receipt.operationId);
        return {...receipt,state:'FAILED'};
      }
      if(operation==='datasets.unregister'){
        // The real M2 wrapper must commit its exclusion before the bridge write.
        // Calling assertAnotherCompleteCopy outside its lane cannot pass this.
        const rows=f.s.db.prepare('SELECT * FROM dataset_removal_exclusions').all();
        assert.equal(rows.length,1);assert.equal(rows[0].machine,host);
        assert.equal(rows[0].dataset,'sample');assert.equal(rows[0].version,VERSION);
        assert.equal(rows[0].operation_id,null);assert.equal(rows[0].scope_version,args.version??null);
        receipt={operationId:OPERATION,dataset:args.dataset,version:args.version??null,state:'UNREGISTERING'};
        f.respond(receipt);
      }
      return bridge(host,operation,args);
    };
    for(const extra of [{},{version:null},{version:VERSION}]){
      const before=f.calls.length;
      const result=(await f.s.invoke(f.admin.token,'datasets.unregister',{machine,dataset:'sample',...extra})).result;
      assert.deepEqual(result,receipt);
      const current=f.calls.slice(before),writes=current.filter(call=>call.operation==='datasets.unregister');
      // This is main's exact bridge request shape, including omitted vs null.
      assert.deepEqual(writes,[{machine,operation:'datasets.unregister',args:{dataset:'sample',...extra,userId:'builtin-admin',hostAdmin:true}}]);
      assert.deepEqual(current.filter(call=>call.operation==='datasets.list').slice(0,MACHINES.length).map(call=>call.machine),MACHINES.map(host=>host.id));
      assert(current.findIndex(call=>call.operation==='datasets.unregister')>=MACHINES.length);
      assert.equal(f.s.db.prepare('SELECT operation_id FROM dataset_removal_exclusions').get().operation_id,OPERATION);
    }
    assert.deepEqual(reads,Array.from({length:3},()=>({machine,operation:'storage.dataset-delete.capabilities',args:{userId:'builtin-admin',hostAdmin:true}})));
    assert.equal(f.s.store.jobs.length,0);
  }
});

test('unregister forwards optional versions and server-owned identity without reserving or stopping jobs',async t=>{
  const f=await apiFixture(t);
  for(const extra of [{},{version:null},{version:VERSION}]){
    const out=await f.s.invoke(f.admin.token,'datasets.unregister',{machine:'gpu-2',dataset:'sample',...extra});
    assert.equal(out.result.state,'UNREGISTERING');assert.equal(out.result.unregistered,undefined);
    assert.deepEqual(f.calls.at(-1),{machine:'gpu-2',operation:'datasets.unregister',args:{dataset:'sample',...extra,userId:'builtin-admin',hostAdmin:true,
      protocol:'dataset-delete-node-v1',portalProvedOtherCopy:{protocol:'dataset-portal-copy-proof-v1',versions:[VERSION]}}});
  }
  assert.equal(f.s.store.jobs.length,0);
  assert.equal(f.calls.filter(c=>c.operation==='datasets.unregister').length,3);
  assert.ok(f.calls.every(c=>['datasets.unregister','datasets.list','datasets.status'].includes(c.operation)));
  assert.ok(f.calls.filter(c=>c.operation==='datasets.list').every(c=>c.args.hostAdmin===true&&c.args.userId==='builtin-admin'));
  const audit=f.s.db.prepare("SELECT * FROM audit WHERE operation='datasets.unregister'").all();
  assert.equal(audit.length,3);assert.deepEqual(audit.map(a=>a.outcome),['sample','sample','sample@'+VERSION]);
});

test('unregister rejects paths, actor injection, malformed versions and unauthorized machines before bridge',async t=>{
  const f=await apiFixture(t);
  for(const extra of [{dataset:undefined},{dataset:''},{dataset:'../sample'},{dataset:'/data2'},{dataset:['sample']},
    {version:''},{version:'latest'},{version:3},{version:VERSION.toUpperCase()},
    {sourcePath:'/source'},{sourceId:'approved'},{force:true},{owners:['someone']},{userId:'demo-user-1'},
    {hostAdmin:true},{actor:{is_admin:true}},{operationId:OPERATION},
    {machine:undefined},{machine:'auto'},{machine:'unknown'}]){
    await assert.rejects(f.s.invoke(f.admin.token,'datasets.unregister',{machine:'gpu-1',dataset:'sample',...extra}));
  }
  assert.equal(f.calls.length,0);
});

test('intent audit must persist before unregister starts; bridge failure never claims completion',async t=>{
  const f=await apiFixture(t),audit=f.s.audit;
  f.s.audit=()=>{throw Error('audit full');};
  await assert.rejects(f.s.invoke(f.admin.token,'datasets.unregister',{machine:'gpu-1',dataset:'sample'}),/audit full/);
  assert.equal(f.calls.length,0);f.s.audit=audit;
  f.fail(Error('bridge timeout'));
  await assert.rejects(f.s.invoke(f.admin.token,'datasets.unregister',{machine:'gpu-1',dataset:'sample'}),/bridge timeout/);
  assert.equal(f.calls.filter(c=>c.operation==='datasets.unregister').length,1);
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM audit WHERE operation='datasets.unregister'").get().n,1);
});

test('operation status is strict, preserves FAILED/UNKNOWN and never dispatches another unregister',async t=>{
  const f=await apiFixture(t);
  for(const state of ['UNREGISTERING','UNREGISTERED','FAILED','UNKNOWN']){
    const response={operationId:OPERATION,state,...(state==='UNREGISTERED'?{unregistered:true,recoveryId:'unregister-'+'c'.repeat(32)}:{})};
    f.respond(response);
    assert.deepEqual((await f.s.invoke(f.admin.token,'datasets.status',{machine:'gpu-1',operationId:OPERATION})).result,response);
  }
  assert.ok(f.calls.every(c=>c.operation==='datasets.status'));
  const count=f.calls.length;
  for(const extra of [{operationId:''},{operationId:3},{operationId:'../bad'},{dataset:'sample'},{version:VERSION},{userId:'other'}])
    await assert.rejects(f.s.invoke(f.admin.token,'datasets.status',{machine:'gpu-1',operationId:OPERATION,...extra}));
  assert.equal(f.calls.length,count);
  f.fail(Error('Administrator authorization required'));
  await assert.rejects(f.s.invoke(f.member.token,'datasets.status',{machine:'gpu-1',operationId:OPERATION}),/Administrator/);
  assert.equal(f.calls.at(-1).args.hostAdmin,false);
});

async function cliFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-unregister-cli-')),file=join(dir,'session'),calls=[];
  let response={operationId:OPERATION,dataset:'sample',version:null,state:'UNREGISTERING'},failure=null;
  const state={demo:false,gpuqConnected:true,machines:[{id:'gpu-1'},{id:'gpu-2'}],users:[],jobs:[]};
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');let raw='';for await(const chunk of req)raw+=chunk;
    const data=JSON.parse(raw);calls.push(data);
    if(data.operation==='state'){res.end(JSON.stringify({state}));return;}
    if(failure){res.statusCode=503;res.end(JSON.stringify({error:failure}));return;}
    res.end(JSON.stringify({result:response}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const save=async(extra={})=>writeFile(file,JSON.stringify({url,token:'fixture',machine:'gpu-1',principal:{userId:'builtin-admin',role:'admin'},...extra}),{mode:0o600});
  await save();
  const cli=(args,json=true)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--url',url,'--session-file',file,...(json?['--json']:[]),...args]);
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);
    child.on('close',code=>resolve({code,stdout,stderr,data:json&&stdout?JSON.parse(stdout).data:null}));child.stdin.end();
  });
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return {cli,calls,save,respond:value=>response=value,fail:value=>failure=value};
}

test('CLI unregister accepts NAME or full NAME@VERSION and returns accepted operation without waiting',async t=>{
  const f=await cliFixture(t);
  for(const [name,extra] of [['sample',{}],['sample@'+VERSION,{version:VERSION}]]){
    const result=await f.cli(['data','unregister',name,'--machine','2']);
    assert.equal(result.code,0,result.stderr);assert.equal(result.data.state,'UNREGISTERING');assert.equal(result.data.unregistered,undefined);
    assert.deepEqual(f.calls.at(-1),{operation:'datasets.unregister',args:{machine:'gpu-2',dataset:'sample',...extra}});
  }
  assert.equal(f.calls.filter(c=>c.operation==='datasets.status').length,0);
  const text=await f.cli(['data','unregister','sample'],false);
  assert.match(text.stdout,/已受理注销，尚未完成/);assert.match(text.stdout,new RegExp('data status '+OPERATION));
});

test('CLI operation status distinguishes confirmed success, failure and unknown',async t=>{
  const f=await cliFixture(t);
  for(const [state,code] of [['UNREGISTERING',0],['FAILED',1],['UNKNOWN',3],['UNREGISTERED',0]]){
    f.respond({operationId:OPERATION,state,dataset:'sample',unregistered:state==='UNREGISTERED'});
    const result=await f.cli(['data','status',OPERATION,'--machine','gpu-2']);
    assert.equal(result.code,code,result.stderr);assert.equal(result.data.state,state);
    assert.deepEqual(f.calls.at(-1),{operation:'datasets.status',args:{machine:'gpu-2',operationId:OPERATION}});
  }
  f.respond({operationId:OPERATION,state:'UNREGISTERED',dataset:'sample',unregistered:true,recoveryId:'unregister-'+'c'.repeat(32)});
  assert.match((await f.cli(['data','status',OPERATION],false)).stdout,/已注销/);
});

test('CLI rejects malformed references, member deletion, extra commands and unrelated flags',async t=>{
  const f=await cliFixture(t);
  for(const args of [['data','unregister'],['data','unregister','../sample'],['data','unregister','/data2'],
    ['data','unregister','sample@'],['data','unregister','sample@latest'],['data','unregister','sample@'+VERSION+'@x'],
    ['data','unregister','sample','extra'],['data','unregister','sample','--','rm'],
    ['data','unregister','sample','--as','someone'],['data','unregister','sample','--root'],
    ['data','unregister','sample','--project','x'],['data','unregister','sample','--key','x'],
    ['data','unregister','sample','--machine','auto'],['data','status','not-an-operation']])
    assert.equal((await f.cli(args)).code,1,args.join(' '));
  await f.save({principal:{userId:'demo-user-1',role:'member'}});
  assert.equal((await f.cli(['data','unregister','sample'])).code,1);
  assert.equal(f.calls.some(c=>c.operation==='datasets.unregister'),false);
  const help=await f.cli(['--help'],false);assert.match(help.stdout,/data unregister NAME\[@VERSION\]/);assert.match(help.stdout,/data status OPERATION_ID/);
});

test('CLI submit timeout explicitly remains uncertain and does not implicitly repeat or cancel',async t=>{
  const f=await cliFixture(t);f.fail('node response timeout');
  const result=await f.cli(['data','unregister','sample']);assert.equal(result.code,1);
  assert.match(result.stderr,/outcome is unconfirmed/);assert.match(result.stderr,/may still run/);
  assert.equal(f.calls.filter(c=>c.operation==='datasets.unregister').length,1);
});
