import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,rm,stat,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const RELEASE='a'.repeat(64),OLDER='b'.repeat(64),JOB='11111111-2222-4333-8444-555555555555';
const principal={userId:'demo-user-1',username:'tester',role:'member'};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-projects-cli-')),session=join(dir,'session.json'),calls=[];
  let releases=[{release:RELEASE,state:'READY'},{release:OLDER,state:'READY'}],latest=RELEASE;
  const custom=new Map();
  const state={demo:false,gpuqConnected:true,machines:[{id:'gpu-1'},{id:'gpu-2'}],users:[],jobs:[]};
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const data of req)raw+=data;
      const body=JSON.parse(raw);res.setHeader('Content-Type','application/json');
      if(req.url==='/api/login'){res.end(JSON.stringify({token:'new-test-token',principal,state}));return;}
      const {operation,args={}}=body;calls.push({operation,args});
      if(operation==='state'){res.end(JSON.stringify({state}));return;}
      if(custom.has(operation)){const value=await custom.get(operation)(args);res.end(JSON.stringify({result:value}));return;}
      const result=operation==='projects.list'?{projects:[{project:'alpha',state:'READY',releases,latestReadyRelease:latest}]}:
        operation.startsWith('projects.')?{project:args.project,state:'READY',releases,latestReadyRelease:latest,environmentMode:args.environmentMode||'shared'}:
        operation==='files.list'?{entries:[]}:
        operation==='files.get'?{data:Buffer.from('checkpoint').toString('base64'),eof:true}:
        operation==='files.put'&&args.project?{complete:args.final,size:args.offset+Buffer.from(args.data,'base64').length,...(args.final?{sha256:args.sha256}:{})}:
        operation==='jobs.submit'?{id:JOB,state:'QUEUED',machine:args.machine,cards:args.cards}:{};
      res.end(JSON.stringify({result}));
    }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  const save=extra=>writeFile(session,JSON.stringify({url,token:'test-only',principal,machine:'gpu-1',...extra}),{mode:0o600});
  await save({});
  const cli=(args,input='',preload=null)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[...(preload?['--import',preload]:[]),new URL('../cli.mjs',import.meta.url).pathname,'--url',url,'--session-file',session,'--json',...args]);
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);
    child.on('close',code=>resolve({code,data:stdout?JSON.parse(stdout).data:null,stderr}));child.stdin.end(input);
  });
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  return {dir,session,calls,cli,save,custom,setReleases:(value,head)=>{releases=value;latest=head;}};
}

test('project create/use is verified and remembered per machine; changing server never reuses another project',async t=>{
  const f=await fixture(t);
  assert.equal((await f.cli(['project','create','alpha'])).code,0);
  assert.deepEqual(f.calls.at(-1),{operation:'projects.create',args:{machine:'gpu-1',project:'alpha'}});
  assert.deepEqual(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine,{'gpu-1':'alpha'});
  assert.equal((await f.cli(['use','2'])).data.project,null);
  assert.equal((await f.cli(['project','use','beta'])).code,0);
  assert.deepEqual(f.calls.at(-1),{operation:'projects.status',args:{machine:'gpu-2',project:'beta'}});
  assert.equal((await f.cli(['use','1'])).data.project,'alpha');
  const cache=JSON.parse(await readFile(f.session,'utf8'));assert.deepEqual(cache.projectsByMachine,{'gpu-1':'alpha','gpu-2':'beta'});
  assert.equal((await stat(f.session)).mode&0o777,0o600);
  f.custom.set('projects.status',()=>{throw Error('project not found');});
  assert.equal((await f.cli(['project','use','missing'])).code,1);
  assert.equal(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine['gpu-1'],'alpha');
});

test('project list/status/publish use selected context; publication does not claim a submission key',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  assert.equal((await f.cli(['project','list'])).data.projects[0].project,'alpha');
  assert.deepEqual(f.calls.at(-1),{operation:'projects.list',args:{machine:'gpu-1'}});
  assert.equal((await f.cli(['project','status'])).code,0);
  assert.equal((await f.cli(['project','publish'])).code,0);
  assert.deepEqual(f.calls.at(-1),{operation:'projects.publish',args:{machine:'gpu-1',project:'alpha'}});
  assert.equal((await f.cli(['project','publish','--key',JOB])).code,1);
  assert.equal((await f.cli(['project','status','beta','--machine','2'])).code,0);
  assert.deepEqual(f.calls.at(-1),{operation:'projects.status',args:{machine:'gpu-2',project:'beta'}});
});
test('project quota queries only the selected machine and preserves unknown disabled usage',async t=>{
 const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
 f.custom.set('projects.quota',()=>({enabled:false,enforcement:null,owner:principal.userId,volumes:null}));
 const value=await f.cli(['project','quota']);assert.equal(value.code,0,value.stderr);assert.equal(value.data.volumes,null);
 assert.deepEqual(f.calls.at(-1),{operation:'projects.quota',args:{machine:'gpu-1'}});
 for(const args of [['project','quota','alpha'],['project','quota','--project','alpha'],['project','quota','--env-mode','oci']]){
  const before=f.calls.filter(c=>c.operation==='projects.quota').length;assert.equal((await f.cli(args)).code,1);assert.equal(f.calls.filter(c=>c.operation==='projects.quota').length,before);
 }
});
test('project create forwards only explicit environment mode and rejects mutation on other commands',async t=>{
  const f=await fixture(t);
  for(const mode of ['shared','isolated','oci']){
    assert.equal((await f.cli(['project','create','clean','--env-mode',mode])).code,0);
    assert.deepEqual(f.calls.at(-1),{operation:'projects.create',args:{machine:'gpu-1',project:'clean',environmentMode:mode}});
  }
  for(const args of [['project','create','bad','--env-mode','auto'],['project','status','clean','--env-mode','isolated'],['project','publish','clean','--env-mode','isolated'],['ssh','--env-mode','isolated']]){
    const before=f.calls.filter(call=>call.operation!=='state').length;
    assert.equal((await f.cli(args)).code,1);assert.equal(f.calls.filter(call=>call.operation!=='state').length,before);
  }
  f.custom.set('projects.create',args=>({project:args.project,state:'DRAFT'}));
  const unsupported=await f.cli(['project','create','unsupported','--env-mode','isolated']);
  assert.equal(unsupported.code,1);assert.match(unsupported.stderr,/did not confirm isolated/);
  assert.notEqual(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine['gpu-1'],'unsupported');
});

test('terminal open/exchange/close preserve selected project and use top-level rows/cols',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const preload=join(f.dir,'fake-tty.mjs');
  await writeFile(preload,'Object.defineProperty(process.stdin,"isTTY",{value:true});process.stdin.setRawMode=()=>process.stdin;');
  f.custom.set('terminal.open',()=>({id:JOB,writerToken:randomUUID()}));
  f.custom.set('terminal.exchange',()=>({offset:0,data:'',exited:true}));
  f.custom.set('terminal.close',()=>({closed:true}));
  const result=await f.cli(['ssh'],'',preload);assert.equal(result.code,0,result.stderr);
  const calls=f.calls.filter(c=>c.operation.startsWith('terminal.'));assert.equal(calls.length,3);
  for(const c of calls){assert.equal(c.args.machine,'gpu-1');assert.equal(c.args.project,'alpha');assert.equal(c.args.hostAdmin,false);}
  assert.equal(calls[1].args.cols,110);assert.equal(calls[1].args.rows,32);assert.equal('size'in calls[1].args,false);
  f.calls.length=0;assert.equal((await f.cli(['ssh','--root'],'',preload)).code,0);
  for(const c of f.calls.filter(c=>c.operation.startsWith('terminal.'))){assert.equal(c.args.hostAdmin,true);assert.equal('project'in c.args,false);}
});
test('same login CLI invocations create separate clients and reconnect/takeover is explicit',async t=>{
  const f=await fixture(t),preload=join(f.dir,'isolated-tty.mjs');
  await writeFile(preload,'Object.defineProperty(process.stdin,"isTTY",{value:true});process.stdin.setRawMode=()=>process.stdin;');
  f.custom.set('terminal.open',args=>({id:args.id||randomUUID(),writerToken:randomUUID()}));
  f.custom.set('terminal.exchange',()=>({offset:0,data:'',exited:true}));
  f.custom.set('terminal.close',()=>({closed:true}));
  for(let n=0;n<2;n++)assert.equal((await f.cli(['ssh'],'',preload)).code,0);
  const opens=f.calls.filter(call=>call.operation==='terminal.open');
  assert.equal(opens.length,2);assert.notEqual(opens[0].args.clientId,opens[1].args.clientId);assert.notEqual(opens[0].args.key,opens[1].args.key);
  for(const call of opens){assert.equal(call.args.mode,'new');assert.equal('id'in call.args,false);}
  assert.equal((await f.cli(['ssh','--reconnect',JOB,'--takeover'],'',preload)).code,0);
  const reconnect=f.calls.filter(call=>call.operation==='terminal.open').at(-1).args;
  assert.equal(reconnect.id,JOB);assert.equal(reconnect.mode,'reconnect');assert.equal(reconnect.takeover,true);
  const invalid=await f.cli(['ssh','--takeover'],'',preload);assert.equal(invalid.code,1);assert.match(invalid.stderr,/requires --reconnect/);
});

test('Ctrl+] releases the writer lease instead of closing the retained PTY',async t=>{
  const f=await fixture(t),preload=join(f.dir,'detach-tty.mjs');
  await writeFile(preload,'Object.defineProperty(process.stdin,"isTTY",{value:true});process.stdin.setRawMode=value=>{if(value)setTimeout(()=>process.stdin.emit("data",Buffer.from([29])),30);return process.stdin;};');
  f.custom.set('terminal.open',()=>({id:JOB,writerToken:randomUUID()}));
  f.custom.set('terminal.exchange',()=>({offset:0,data:'',exited:false}));
  f.custom.set('terminal.detach',()=>({detached:true}));
  const result=await f.cli(['ssh'],'',preload);assert.equal(result.code,0,result.stderr);
  assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
  assert.equal(f.calls.filter(call=>call.operation==='terminal.detach').length,1);
  assert.match(result.stderr,/--reconnect/);
});

test('run selects latest READY release without publishing; exact argv and dataset refs preserved',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const result=await f.cli(['run','-g','2','--key',JOB,'--data','images@'+OLDER,'--','python','train.py','-g','private','--json']);
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(f.calls.at(-1),{operation:'jobs.submit',args:{machine:'gpu-1',cards:2,minVramGiB:0,name:'train',argv:['python','train.py','-g','private','--json'],key:JOB,project:'alpha',release:RELEASE,datasets:[{dataset:'images',version:OLDER}],prepareData:true}});
  assert.equal(f.calls.some(c=>c.operation==='projects.publish'),false);
  assert.equal((await f.cli(['run','--release',OLDER,'--','python','train.py'])).code,0);
  assert.equal(f.calls.at(-1).args.release,OLDER);
});

test('run refuses missing or unready release before jobs.submit and never chooses another machine',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  f.setReleases([{release:RELEASE,state:'PUBLISHING'}],RELEASE);
  let result=await f.cli(['run','--','true']);assert.equal(result.code,1);assert.match(result.stderr,/project publish/);
  assert.equal(f.calls.some(c=>c.operation==='jobs.submit'),false);
  f.calls.length=0;result=await f.cli(['run','auto','--legacy','--','true']);assert.equal(result.code,1);assert.match(result.stderr,/手选服务器/);
  assert.equal(f.calls.some(c=>c.operation!=='state'),false);
  f.calls.length=0;result=await f.cli(['run','--legacy','--release',RELEASE,'--','true']);assert.equal(result.code,1);
  assert.equal(f.calls.some(c=>c.operation==='jobs.submit'),false);
});

test('project override is temporary and legacy jobs keep their old exact request shape',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  assert.equal((await f.cli(['run','--project','beta','--','true'])).code,0);assert.equal(f.calls.at(-1).args.project,'beta');
  assert.equal(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine['gpu-1'],'alpha');
  assert.equal((await f.cli(['run','--legacy','--key',JOB,'--','true'])).code,0);
  assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',cards:1,minVramGiB:0,name:'train',argv:['true'],key:JOB});
  assert.equal((await f.cli(['run','--legacy','--project','alpha','--','true'])).code,1);
});

test('project code upload uses full-file digest + stable upload id + final chunk and skips known secrets/envs',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const source=join(f.dir,'code'),bytes=Buffer.alloc(1024*1024+17,67);await mkdir(source);
  await writeFile(join(source,'train.py'),bytes);await writeFile(join(source,'.env'),'secret');await writeFile(join(source,'.env.example'),'example');
  await writeFile(join(source,'sample.pem'),'ordinary fixture');await mkdir(join(source,'.venv'));await writeFile(join(source,'.venv','ignored'),'local env');
  const result=await f.cli(['push',source]);assert.equal(result.code,0,result.stderr);assert.equal(result.data.uploaded,3);assert.equal(result.data.skipped,2);
  const all=f.calls.filter(c=>c.operation==='files.put').map(c=>c.args),chunks=all.filter(a=>a.path==='train.py');assert.equal(chunks.length,2);
  assert.equal(chunks[0].sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(chunks[0].uploadId,chunks[1].uploadId);
  assert.equal(chunks[0].final,false);assert.equal(chunks[1].final,true);assert.equal(chunks[1].offset,1024*1024);
  for(const c of chunks){assert.equal(c.project,'alpha');assert.equal(c.area,'code');assert.equal(c.totalSize,bytes.length);assert.equal('truncate'in c,false);}
  assert.equal(all.some(a=>a.path==='.env'),false);assert.equal(all.some(a=>a.path==='sample.pem'),true);assert.equal(all.some(a=>a.path==='.env.example'),true);
});

test('empty project files finalize correctly; mutation during upload rejects without a final chunk',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const empty=join(f.dir,'empty');await writeFile(empty,'');assert.equal((await f.cli(['push',empty])).code,0);
  const zero=f.calls.at(-1).args;assert.equal(zero.final,true);assert.equal(zero.totalSize,0);assert.equal(zero.data,'');
  const source=join(f.dir,'change.py');await writeFile(source,Buffer.alloc(1024*1024+99,65));
  f.calls.length=0;f.custom.set('files.put',async()=>{await writeFile(source,'changed');return {};});
  const result=await f.cli(['push',source]);assert.equal(result.code,1);assert.match(result.stderr,/changed/);
  assert.equal(f.calls.filter(c=>c.operation==='files.put').some(c=>c.args.final),false);
});

test('oversized project files are rejected before hashing or transfer',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const source=join(f.dir,'dataset.bin'),fd=await open(source,'w');await fd.truncate(4*1024**3+1);await fd.close();
  const result=await f.cli(['push',source]);assert.equal(result.code,1);assert.match(result.stderr,/4 GiB/);
  assert.equal(f.calls.some(c=>c.operation==='files.put'),false);
});

test('project upload does not claim success without matching server verification receipt',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const source=join(f.dir,'file');await writeFile(source,'verified');f.custom.set('files.put',()=>({complete:false}));
  const result=await f.cli(['push',source]);assert.equal(result.code,1);assert.match(result.stderr,/did not confirm/);
});

test('files/pull target only selected project outputs and reject output writes',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  assert.equal((await f.cli(['files'])).code,0);assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',path:'.',project:'alpha',area:'code'});
  assert.equal((await f.cli(['files','checkpoints','--job',JOB])).code,0);
  assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',path:'checkpoints',project:'alpha',area:'output',runId:JOB});
  const output=join(f.dir,'model.pt');assert.equal((await f.cli(['pull','--job',JOB,'model.pt',output])).code,0);
  assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',path:'model.pt',offset:0,project:'alpha',area:'output',runId:JOB});
  assert.equal(await readFile(output,'utf8'),'checkpoint');
  assert.equal((await f.cli(['push',output,'--job',JOB])).code,1);
  assert.equal((await f.cli(['files','--legacy','--job',JOB])).code,1);
});

test('legacy uploads retain truncate format; explicit files machine remains compatible',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const source=join(f.dir,'file');await writeFile(source,'legacy');assert.equal((await f.cli(['push',source,'--legacy'])).code,0);
  assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',path:'file',offset:0,truncate:true,data:Buffer.from('legacy').toString('base64')});
  assert.equal((await f.cli(['files','gpu-2','subdir'])).code,0);assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-2',path:'subdir'});
});

test('login preserves per-machine projects only for the same principal',async t=>{
  const f=await fixture(t);const projectsByMachine={'gpu-1':'alpha','gpu-2':'beta'};await f.save({projectsByMachine});
  assert.equal((await f.cli(['login','tester','--password-stdin'],'test-only\n')).code,0);
  assert.deepEqual(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine,projectsByMachine);
  await f.save({principal:{...principal,userId:'demo-user-99'},projectsByMachine});
  assert.equal((await f.cli(['login','tester','--password-stdin'],'test-only\n')).code,0);
  assert.equal(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine,undefined);
});

test('invalid slugs, releases and UUIDs fail before any API work',async t=>{
  const f=await fixture(t);
  for(const args of [['files','--project','../escape'],['run','--release','bad','--','true'],['pull','--job','not-an-id','x','y']]){
    assert.equal((await f.cli(args)).code,1);
  }
  assert.equal(f.calls.length,0);
  assert.equal((await f.cli(['project','create','bad/name'])).code,1);assert.equal(f.calls.some(c=>c.operation==='projects.create'),false);
});
