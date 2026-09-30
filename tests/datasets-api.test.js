import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {request,createServer as httpServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createPortalServer} from '../portal-server.mjs';
import {datasetReferences,usage} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';

const password='Dataset-Only-Test-Password-2026!';
const version='a'.repeat(64),otherVersion='b'.repeat(64);
const reference={dataset:'sample',version};

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-datasets-api-'));
  const database=join(dir,'state.sqlite'),bootstrap=join(dir,'bootstrap.json'),statusPath=join(dir,'status.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({
    id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),
    gpuq:{connected:true,observeOnly:false,schedulableIndices:m.id==='gpu-1'?[0,1,2,3]:[0],jobs:[]}
  }))}));
  const calls=[],states=new Map(),deniedOwners=new Set();let failure=null;
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation.startsWith('datasets.')){
      if(failure)throw failure;
      if(!args.hostAdmin&&deniedOwners.has(args.userId))throw Error('dataset owner authorization required');
      if(operation==='datasets.list')return {datasets:[{dataset:'sample',versions:[{version,state:'READY'}]}]};
      const state=states.get(machine+':'+args.dataset)??'READY';
      if(state instanceof Error)throw state;
      return {dataset:args.dataset,version:args.version,state,remainingBytes:state==='READY'?0:64};
    }
    return {state:'PENDING',nodeJobId:'node-'+args.job.id,assignedIndices:[]};
  };
  const origin='https://gpuq.example.test';
  let server,service;
  async function start(){
    ({server,service}=await createPortalServer({database,bootstrap,origin,statusPath,bridge}));
    clearInterval(service.executionTimer);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  }
  await start();
  let admin=await service.login('admin',password);
  const member=(await service.invoke(admin.token,'users.create',{username:'dataset-user',password})).result;
  const other=(await service.invoke(admin.token,'users.create',{username:'other-user',password})).result;
  let user=await service.login('dataset-user',password),outsider=await service.login('other-user',password);
  async function settle(){await new Promise(resolve=>setImmediate(resolve));while(service.reconciling)await new Promise(resolve=>setTimeout(resolve,5));}
  const post=(operation,args={},token=user.token)=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/api/call',method:'POST',headers:{
      Host:'gpuq.example.test','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})
    }},res=>{let data='';res.on('data',part=>data+=part);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(data)}));});
    req.on('error',reject);req.end(JSON.stringify({operation,args}));
  });
  return {get service(){return service},get user(){return user},get admin(){return admin},outsider,member,other,calls,states,deniedOwners,post,settle,
    fail:value=>failure=value,
    grant:async(total=4,limits={'gpu-1':2,'gpu-2':2})=>service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:service.store.get(member.id).policyVersion,total,limits}),
    submit:more=>post('jobs.submit',{machine:'gpu-1',cards:1,argv:['python','train.py'],key:randomUUID(),datasets:[reference],...more}),
    reopen:async()=>{await settle();await new Promise(resolve=>server.close(resolve));await start();admin=await service.login('admin',password);user=await service.login('dataset-user',password);},
    close:async()=>{await settle();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
  };
}

test('dataset list/status/prepare use authenticated identity and preserve node state without reserving GPUs',async()=>{
  const f=await fixture();try{
    await f.grant();
    for(const operation of ['datasets.list','datasets.status','datasets.prepare']){
      const result=await f.post(operation,{machine:'gpu-1',...(operation==='datasets.list'?{}:reference)});
      assert.equal(result.status,200,JSON.stringify(result.data));
      const sent=f.calls.at(-1);assert.equal(sent.args.userId,f.member.id);assert.equal(sent.args.hostAdmin,false);
      if(operation!=='datasets.list')assert.equal(result.data.result.state,'READY');
    }
    const admin=await f.post('datasets.status',{machine:'gpu-1',...reference},f.admin.token);
    assert.equal(admin.status,200);assert.equal(f.calls.at(-1).args.userId,'builtin-admin');assert.equal(f.calls.at(-1).args.hostAdmin,true);
    assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM audit WHERE operation='datasets.prepare'").get().n,1);
  }finally{await f.close();}
});

test('dataset endpoints reject identity/path spoofing, unauthorized machines and unauthenticated callers before bridge',async()=>{
  const f=await fixture();try{
    await f.grant();
    for(const operation of ['datasets.list','datasets.status','datasets.prepare']){
      const args={machine:'gpu-1',...(operation==='datasets.list'?{}:reference)};
      for(const extra of [{userId:f.other.id},{hostAdmin:true},{role:'admin'},{path:'/private/source'},{sourceId:'secret'}]){
        assert.equal((await f.post(operation,{...args,...extra})).status,400);
      }
      assert.equal((await f.post(operation,{...args,machine:'gpu-4'})).status,403);
      assert.equal((await f.post(operation,args,f.outsider.token)).status,403);
      assert.equal((await f.post(operation,args,null)).status,401);
    }
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('personal upload API is member-accessible and always derives an unprivileged owner',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    const requests={begin:{name:'my-data',key,manifestBytes:99,manifestSha256:version,totalBytes:64,entries:1},manifest:{uploadId:key,offset:0,data:Buffer.from('{}').toString('base64')},seal:{uploadId:key},status:{uploadId:key,path:'a/b.txt'},chunk:{uploadId:key,path:'a/b.txt',offset:0,data:Buffer.alloc(1024*1024).toString('base64')},commit:{uploadId:key},discard:{uploadId:key}};
    for(const [action,args] of Object.entries(requests)){
      const response=await f.post('datasets.upload.'+action,{machine:'gpu-1',...args});
      assert.equal(response.status,200,JSON.stringify(response.data));
      assert.deepEqual(f.calls.at(-1),{machine:'gpu-1',operation:'datasets.upload.'+action,args:{...args,userId:f.member.id,hostAdmin:false}});
    }
    await f.post('datasets.upload.begin',{machine:'gpu-1',...requests.begin},f.admin.token);
    assert.equal(f.calls.at(-1).args.hostAdmin,false);
    assert.equal(f.calls.at(-1).args.userId,'builtin-admin');
    assert.equal(f.service.store.jobs.length,0);
  }finally{await f.close();}
});

test('personal upload rejects identity injection and revoked machine access before any node request',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    for(const action of ['begin','manifest','seal','status','chunk','commit','discard']){
      const args=action==='begin'?{machine:'gpu-1',name:'data',key,manifestBytes:1,manifestSha256:version,totalBytes:0,entries:0}:action==='manifest'?{machine:'gpu-1',uploadId:key,offset:0,data:''}:action==='chunk'?{machine:'gpu-1',uploadId:key,path:'a',offset:0,data:''}:{machine:'gpu-1',uploadId:key};
      for(const extra of [{userId:f.other.id},{hostAdmin:true},{sourceId:'source'},{owners:[f.member.id]},{root:'/tmp'},{dataset:'other'},{version}])assert.equal((await f.post('datasets.upload.'+action,{...args,...extra})).status,400);
      assert.equal((await f.post('datasets.upload.'+action,{...args,machine:'gpu-4'})).status,403);
      assert.equal((await f.post('datasets.upload.'+action,args,f.outsider.token)).status,403);
      assert.equal((await f.post('datasets.upload.'+action,args,null)).status,401);
    }
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('personal upload bounds request metadata, chunk encoding and relative paths',async()=>{
  const f=await fixture();try{
    await f.grant();const uploadId=randomUUID(),base={machine:'gpu-1',uploadId,path:'file',offset:0,data:'YQ=='};
    for(const path of ['/etc/passwd','../foo','a/../b','a//b','a\\b','.ssh/key','a\0b','x'.repeat(4097)])assert.equal((await f.post('datasets.upload.chunk',{...base,path})).status,400);
    for(const data of ['YQ=','YR==','!!!!','YQ==\n',Buffer.alloc(1024*1024+1).toString('base64')])assert.equal((await f.post('datasets.upload.chunk',{...base,data})).status,400);
    for(const offset of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'0'])assert.equal((await f.post('datasets.upload.chunk',{...base,offset})).status,400);
    const begin={machine:'gpu-1',name:'data',key:uploadId,manifestBytes:1,manifestSha256:version,totalBytes:0,entries:0};
    for(const extra of [{name:'../x'},{name:'x'.repeat(41)},{manifestBytes:64*1024*1024+1},{manifestSha256:'short'},{entries:500001},{totalBytes:-1},{key:'bad'}])assert.equal((await f.post('datasets.upload.begin',{...begin,...extra})).status,400);
    assert.equal((await f.post('datasets.upload.unknown',{machine:'gpu-1',uploadId})).status,400);
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('dataset reference validation rejects coerced names/hashes, duplicate names, paths and additional properties',()=>{
  for(const datasets of [null,{},[{dataset:123,version}],[{dataset:['sample'],version}],[{dataset:'sample',version:[version]}],
    [{dataset:['sample'],version},{dataset:['sample'],version}], [{...reference,path:'/tmp/source'}],
    [{dataset:'../private',version}],[{dataset:'sample',version:'short'}],[reference,{...reference,version:otherVersion}],Array(9).fill(reference)]){
    assert.throws(()=>datasetReferences(datasets),undefined,JSON.stringify(datasets));
  }
  assert.deepEqual(datasetReferences(undefined),[]);assert.deepEqual(datasetReferences([]),[]);
  assert.deepEqual(datasetReferences([reference]),[reference]);
});

test('HTTP job submission requires an explicit machine before querying dataset readiness',async()=>{
  const f=await fixture();try{
    await f.grant();
    for(const machine of [undefined,'auto','',null,'unknown-machine',{},['gpu-1']]){
      const result=await f.submit({machine});
      assert.equal(result.status,400,JSON.stringify(result.data));
      assert.match(result.data.error,/明确选择.*服务器/);
    }
    await f.settle();assert.equal(f.calls.length,0);
    assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
  }finally{await f.close();}
});

test('administrator training requires dataset ownership before reservation while management visibility remains privileged',async()=>{
  const f=await fixture();try{
    f.deniedOwners.add('builtin-admin');
    for(const operation of ['datasets.list','datasets.status']){
      const response=await f.post(operation,{machine:'gpu-1',...(operation==='datasets.status'?reference:{})},f.admin.token);
      assert.equal(response.status,200,JSON.stringify(response.data));
      assert.equal(f.calls.at(-1).args.hostAdmin,true);
    }
    f.calls.length=0;
    for(const machine of ['gpu-1','gpu-2']){
      const response=await f.post('jobs.submit',{machine,cards:1,argv:['python','train.py'],key:randomUUID(),datasets:[reference]},f.admin.token);
      assert.equal(response.status,403,JSON.stringify(response.data));
      assert.match(response.data.error,/数据集读取授权/);assert.match(response.data.error,/owners/);assert.match(response.data.error,/未占用 GPU/);
      assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,'builtin-admin'),0);
    }
    await f.settle();
    assert.ok(f.calls.length>0);assert.ok(f.calls.every(call=>call.operation==='datasets.status'&&call.args.userId==='builtin-admin'&&call.args.hostAdmin===false));
    assert.equal(f.calls.some(call=>call.operation==='sync'),false);
    assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM audit WHERE operation='jobs.submit' AND outcome='reserved'").get().n,0);
    // Once the actual identity is an owner, an administrator can train without
    // adding a role override to the job spec or widening the node principal.
    f.deniedOwners.delete('builtin-admin');f.calls.length=0;
    const accepted=await f.post('jobs.submit',{machine:'gpu-1',cards:1,argv:['python','train.py'],key:randomUUID(),datasets:[reference]},f.admin.token);
    assert.equal(accepted.status,200,JSON.stringify(accepted.data));await f.settle();
    assert.equal(f.service.store.jobs.length,1);assert.equal(usage(f.service.store.jobs,'builtin-admin'),1);
    assert.equal(f.calls.find(call=>call.operation==='datasets.status').args.hostAdmin,false);
    const spec=f.calls.find(call=>call.operation==='sync').args.job;
    assert.deepEqual(spec.datasets,[reference]);assert.equal(Object.hasOwn(spec,'hostAdmin'),false);
  }finally{await f.close();}
});

test('manual selection uses only that READY replica even when another machine has more idle GPUs',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample','REGISTERED');
    const result=await f.submit({machine:'gpu-2'});assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal(result.data.result.machine,'gpu-2');assert.deepEqual(result.data.result.datasets,[reference]);
    assert.deepEqual(f.service.store.jobs[0].spec.datasets,[reference]);
    await f.settle();
    assert.deepEqual(f.calls.filter(c=>c.operation==='datasets.status').map(c=>c.machine),['gpu-2']);
    assert.deepEqual(f.calls.find(c=>c.operation==='sync').args.job.datasets,[reference]);
    assert.equal(usage(f.service.store.jobs,f.member.id),1);
  }finally{await f.close();}
});

test('all referenced versions must be READY on the same machine; staging never reserves a GPU',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample','STAGING');f.states.set('gpu-2:second','REGISTERED');
    const result=await f.submit({datasets:[reference,{dataset:'second',version:otherVersion}]});
    assert.equal(result.status,409);assert.match(result.data.error,/未占用 GPU/);
    await f.settle();assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    assert.equal(f.calls.some(c=>c.operation==='sync'),false);
    const preparation=await f.post('datasets.prepare',{machine:'gpu-1',...reference});
    assert.equal(preparation.status,200);assert.equal(preparation.data.result.state,'STAGING');
    assert.equal(f.service.store.jobs.length,0);
  }finally{await f.close();}
});

test('readiness transport failures are unavailable, not falsely reported as missing replicas',async()=>{
  const f=await fixture();try{
    await f.grant();f.fail(Error('test transport timeout'));
    const result=await f.submit();assert.equal(result.status,503,JSON.stringify(result.data));
    assert.doesNotMatch(result.data.error,/先用 gpuctl data prepare/);
    assert.equal(f.service.store.jobs.length,0);assert.equal(f.calls.some(c=>c.operation==='sync'),false);
    const status=await f.post('datasets.status',{machine:'gpu-1',...reference});
    assert.notEqual(status.status,200);assert.equal(status.data.result,undefined);
  }finally{await f.close();}
});

test('failed selected-node readiness never falls back to another READY machine',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample',Error('offline'));
    const result=await f.submit();assert.equal(result.status,503,JSON.stringify(result.data));
    assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    assert.deepEqual(f.calls.map(call=>[call.machine,call.operation]),[['gpu-1','datasets.status']]);
  }finally{await f.close();}
});

test('dataset job retry is durable and idempotent; changing versions under the same key conflicts',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    const both=await Promise.all([f.submit({key}),f.submit({key})]);
    assert.equal(both[0].status,200);assert.equal(both[1].status,200);assert.equal(both[0].data.result.id,both[1].data.result.id);
    assert.equal(f.service.store.jobs.length,1);await f.reopen();f.fail(Error('now offline'));
    const again=await f.submit({key});assert.equal(again.status,200);assert.equal(again.data.result.id,both[0].data.result.id);
    const changed=await f.submit({key,datasets:[{...reference,version:otherVersion}]});assert.equal(changed.status,409);
    assert.equal(f.service.store.jobs.length,1);
  }finally{await f.close();}
});

test('legacy jobs without datasets retain their old digest and accept an explicit empty list retry',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    const result=await f.submit({key,datasets:undefined});assert.equal(result.status,200);
    assert.equal(f.service.store.jobs[0].digest,createHash('sha256').update(JSON.stringify(['gpu-1',1,0,['python','train.py'],'train'])).digest('hex'));
    assert.equal(Object.hasOwn(f.service.store.jobs[0].spec,'datasets'),false);
    assert.equal(f.calls.some(c=>c.operation==='datasets.status'),false);
    await f.reopen();const repeated=await f.submit({key,datasets:[]});assert.equal(repeated.status,200);assert.equal(repeated.data.result.id,result.data.result.id);
    const changed=await f.submit({key,datasets:[reference]});assert.equal(changed.status,409);
  }finally{await f.close();}
});

test('CLI dataset operations target the selected machine and run keeps training argv untouched',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-dataset-cli-')),session=join(dir,'session.json'),calls=[];
  const server=httpServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);
    res.setHeader('content-type','application/json');
    if(body.operation==='state')res.end(JSON.stringify({state:{demo:false,machines:[{id:'gpu-1'},{id:'gpu-2'}],users:[],jobs:[]}}));
    else res.end(JSON.stringify({result:body.operation==='jobs.submit'?{id:'job-test',state:'SUBMITTING'}:{state:'READY'}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
  const cli=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--url',url,'--session-file',session,'--json',...args]);
    let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
  });
  try{
    await writeFile(session,JSON.stringify({url,token:'local-test-token',principal:{userId:'user-test',role:'member'},machine:'gpu-2'}));
    for(const action of ['list','status','prepare']){
      const result=await cli(['data',action,...(action==='list'?[]:['sample@'+version])]);assert.equal(result.code,0,result.err);
      assert.equal(calls.at(-1).operation,'datasets.'+action);assert.equal(calls.at(-1).args.machine,'gpu-2');
    }
    // Global flags precede -- so they never become accidental training options.
    const result=await cli(['run','gpu-2','--data','sample@'+version,'--','python','train.py','--data','/data2/sample']);
    assert.equal(result.code,0,result.err);const sent=calls.at(-1).args;
    assert.deepEqual(sent.datasets,[reference]);assert.equal(sent.machine,'gpu-2');
    assert.deepEqual(sent.argv,['python','train.py','--data','/data2/sample']);
    const bad=await cli(['data','status','sample@short']);assert.equal(bad.code,1);assert.match(bad.err,/FULL_VERSION_HASH/);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
