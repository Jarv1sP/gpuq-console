import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,mkdir,cp,access} from 'node:fs/promises';
import {join,basename,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';
import {pathToFileURL} from 'node:url';
import {standaloneClient} from '../client-bundle.mjs';
import {buildClient} from '../scripts/build-client.mjs';
import {usage} from '../execution.mjs';

const password='Maintenance-HTTP-Fixture-2026!';
test('real cookie API and downloaded standalone CLI share requests/decisions, never root before approval',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-maintenance-http-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),scriptFile=join(dir,'request.sh');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));await writeFile(scriptFile,'printf "fixture only\\n"');
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))}));
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='http://127.0.0.1:'+port,calls=[],receipts=new Map();
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args});const id=args.key||args.id;
    if(operation==='host.exec')receipts.set(id,{id,state:'SUCCEEDED',stdout:'fixture only\n',stderr:'',exitCode:0});
    if(!receipts.has(id))throw Error('No receipt');return receipts.get(id);
  };
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath:status,origin,secure:false,bridge});
  clearInterval(service.executionTimer);clearInterval(service.maintenanceTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const post=async(path,body,headers={})=>{const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,data:await r.json(),headers:r.headers};};
  const admin=await service.login('admin',password),owner=(await service.invoke(admin.token,'users.create',{username:'cli-requester',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:owner.id,policyVersion:0});
  const member=await service.login(owner.username,password),session=join(dir,'member-session.json'),adminSession=join(dir,'admin-session.json');
  await writeFile(session,JSON.stringify({url:origin,token:member.token,principal:member.principal,machine:'gpu-1'}));await writeFile(adminSession,JSON.stringify({url:origin,token:admin.token,principal:admin.principal,machine:'gpu-1'}));
  const cliFile=join(dir,'gpuctl.mjs'),download=await fetch(origin+'/gpuctl.mjs');assert.equal(download.status,200);
  const clientSource=await download.text();assert.equal(clientSource,await standaloneClient(origin));assert.doesNotMatch(clientSource,/__GPUQ_PUBLIC_ORIGIN__/);await writeFile(cliFile,clientSource);
  const cli=(args,file=session,json=true)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[cliFile,'--url',origin,'--session-file',file,...(json?['--json']:[]),...args]);let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>resolve({code,err,out,data:json&&out?JSON.parse(out).data:null}));p.stdin.end();});
  const key=randomUUID(),args=['maintenance','request','--name','检查测试依赖','--reason','需要管理员检查','--script-file',scriptFile,'--key',key];
  const submitted=await cli(args);assert.equal(submitted.code,0,submitted.err);assert.equal(submitted.data.state,'PENDING');assert.equal(calls.length,0);
  assert.equal((await cli(args)).data.id,submitted.data.id);assert.equal((await cli(['maintenance','list'])).data.items.length,1);
  assert.equal((await cli(['maintenance','approve',submitted.data.id])).code,1);assert.equal(calls.length,0);
  const cookieLogin=await post('/api/login',{username:'admin',password,client:'browser'},{Origin:origin});const cookie=cookieLogin.headers.get('set-cookie').split(';')[0];
  const call=(operation,args,headers={Cookie:cookie,Origin:origin})=>post('/api/call',{operation,args},headers);
  assert.equal((await call('maintenance.preview',{id:submitted.data.id},{Cookie:cookie})).status,403);
  const preview=await call('maintenance.preview',{id:submitted.data.id});assert.equal(preview.status,200);assert.equal(preview.data.result.request.script,await readFile(scriptFile,'utf8'));
  const returned=await call('maintenance.return',{id:submitted.data.id,revision:1,reason:'请补充说明'});assert.equal(returned.status,200);
  assert.equal((await cli(['maintenance','show',submitted.data.id])).data.decision.reason,'请补充说明');assert.equal(calls.length,0);
  const next=await cli([...args.slice(0,-2),'--parent',submitted.data.id]);assert.equal(next.code,0,next.err);
  const p=await cli(['maintenance','preview',next.data.id],adminSession);assert.equal(p.code,0,p.err);
  const approved=await cli(['maintenance','approve',next.data.id,'--revision',String(p.data.request.revision),'--preview-token',p.data.previewToken],adminSession);
  assert.equal(approved.code,0,approved.err);assert.equal(approved.data.state,'SUCCEEDED');assert.equal((await cli(['maintenance','show',next.data.id])).data.result.stdout,'fixture only\n');
  assert.equal(calls.filter(c=>c.operation==='host.exec').length,1);assert.equal(calls[0].args.userId,'builtin-admin');
  assert.equal((await cli(['maintenance','approve',next.data.id,'--revision','1','--preview-token',p.data.previewToken],adminSession)).code,0);
  assert.equal(calls.filter(c=>c.operation==='host.exec').length,1);
  // Simulate a pre-fix stored request: display must remain safe even though new
  // requests now reject bare CR. The real TTY approval below explicitly declines.
  const legacy=(await service.invoke(member.token,'maintenance.create',{key:randomUUID(),machine:'gpu-1',title:'Display fixture',reason:'Display fixture',script:'printf "fixture only\\n"'})).result;
  const stored=JSON.parse(service.db.prepare('SELECT data FROM maintenance_requests WHERE id=?').get(legacy.id).data);
  Object.assign(stored.payload,{title:'title\u202e\rMASK',reason:'reason\u2066\u0085',script:'printf "UNREVIEWED\\n"; #\rprintf "SAFE\\n"                    \n#\u202e\u0085\t'});
  stored.scriptSha256=createHash('sha256').update(stored.payload.script).digest('hex');
  service.db.prepare('UPDATE maintenance_requests SET data=?,digest=? WHERE id=?').run(JSON.stringify(stored),createHash('sha256').update(JSON.stringify(stored.payload)).digest('hex'),legacy.id);
  for(const action of ['show','preview']){
    const human=await cli(['maintenance',action,legacy.id],adminSession,false);assert.equal(human.code,0,human.err);
    assert.ok(human.out.includes('UNREVIEWED'));assert.ok(human.out.includes('SAFE'));assert.ok(human.out.includes('\\u{000d}'));assert.ok(human.out.includes('\\u{202e}'));assert.ok(human.out.includes('\\u{2066}'));assert.ok(human.out.includes('\\u{0085}'));
    assert.doesNotMatch(human.out,/[\r\u202e\u2066\u0085]/u);
  }
  const listing=await cli(['maintenance','list'],adminSession,false);assert.ok(listing.out.includes('title\\u{202e}\\u{000d}MASK'));assert.doesNotMatch(listing.out,/[\r\u202e]/u);
  const json=await cli(['maintenance','preview',legacy.id],adminSession);assert.equal(json.data.request.script,stored.payload.script);assert.doesNotMatch(json.out,/[\u202e\u2066\u0085]/u);
  if(process.platform!=='win32'){
    const terminal=await new Promise((resolve,reject)=>{
      const child=spawn('python3',[new URL('./maintenance-cli-pty.py',import.meta.url).pathname,process.execPath,cliFile,'--url',origin,'--session-file',adminSession,'maintenance','approve',legacy.id]);let out='',err='';
      child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>{if(code)reject(Error(err||out));else resolve(JSON.parse(out));});
    });
    assert.equal(terminal.exitCode,1);assert.ok(terminal.output.includes('未批准，未执行'));
    assert.ok(terminal.output.includes('UNREVIEWED'));assert.ok(terminal.output.includes('\\u{000d}'));assert.ok(terminal.output.includes('\\u{202e}'));assert.doesNotMatch(terminal.output,/[\u202e\u2066\u0085]/u);
    assert.ok(terminal.output.includes('printf "UNREVIEWED\\n"; #\\u{000d}printf "SAFE\\n"                    '),'the actual approval script must not retain a line-overwriting CR');
  }
  assert.equal(calls.filter(c=>c.operation==='host.exec').length,1,'viewing and declining do not execute the display fixture');
  for(const path of ['/maintenance-ui.js','/maintenance.css'])assert.equal((await fetch(origin+path)).status,200);
  for(const path of ['/maintenance.mjs','/docs/PRIVILEGED_REQUESTS_DESIGN.md','/portal.sqlite'])assert.equal((await fetch(origin+path)).status,404);
  const docker=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8');assert.match(docker,/COPY[^\n]*maintenance\.mjs/);
});
test('approval snapshot round-trips through existing Python Commands receipt/owner protocol (not real ROOT)',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-maintenance-native-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))}));
  const calls=[];
  const {PortalService}=await import('../portal-service.mjs');
  const bridge=(machine,operation,args)=>new Promise((resolve,reject)=>{
    calls.push({machine,operation,args});const p=spawn('python3',[new URL('./maintenance-native-fixture.py',import.meta.url).pathname,dir]);let out='',err='';
    p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>{if(code)reject(Error(err));else try{resolve(JSON.parse(out));}catch(e){reject(e);}});p.stdin.end(JSON.stringify({operation,args}));
  });
  const s=await PortalService.open(join(dir,'db'),bootstrap,status,bridge);clearInterval(s.executionTimer);clearInterval(s.maintenanceTimer);
  t.after(async()=>{s.close();await rm(dir,{recursive:true,force:true});});
  const a=await s.login('admin',password),owner=(await s.invoke(a.token,'users.create',{username:'native-requester',password})).result;
  await s.invoke(a.token,'policy.full',{userId:owner.id,policyVersion:0});const member=await s.login(owner.username,password);
  const r=(await s.invoke(member.token,'maintenance.create',{key:randomUUID(),machine:'gpu-1',title:'协议验收',reason:'本地临时适配器，仅执行固定 printf',cwd:dir,script:'printf "native fixture\\n"'})).result;
  const p=(await s.invoke(a.token,'maintenance.preview',{id:r.id})).result;
  const approved=(await s.invoke(a.token,'maintenance.approve',{id:r.id,revision:r.revision,previewToken:p.previewToken})).result;
  assert.equal(approved.state,'SUCCEEDED');assert.equal(approved.result.stdout,'native fixture\n');assert.equal(approved.result.exitCode,0);
  assert.equal((await s.invoke(member.token,'maintenance.get',{id:r.id})).result.state,'SUCCEEDED');
  await s.invoke(a.token,'maintenance.approve',{id:r.id,revision:r.revision,previewToken:p.previewToken});assert.equal(calls.filter(c=>c.operation==='host.exec').length,1);
});
test('Docker COPY-only runtime starts and serves maintenance assets without source tree or node_modules',async t=>{
  const fixture=await mkdtemp(join(tmpdir(),'gpuq-maintenance-runtime-')),dir=join(fixture,'runtime'),builtClient=join(fixture,'builder/gpuctl.mjs');let server;
  t.after(async()=>{if(server)await new Promise(r=>server.close(r));await rm(fixture,{recursive:true,force:true});});
  await buildClient({outfile:builtClient});
  const docker=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8');
  // Reproduce the final image only. The build stage legitimately contains the
  // source graph and esbuild, neither of which should leak into the runtime.
  const stages=docker.split(/^FROM\s+/m).slice(1);assert.equal(stages.length,2);assert.match(stages[0],/\bAS client-builder\b/);
  for(const line of stages.at(-1).split('\n').filter(s=>s.startsWith('COPY '))){
    const parts=line.split(/\s+/).slice(1).filter(s=>!s.startsWith('--'));
    const destination=parts.pop(),from=line.match(/--from=([^\s]+)/)?.[1];
    if(from){assert.equal(from,'client-builder');assert.deepEqual(parts,['/app/build/gpuctl.mjs']);}
    for(const source of parts){
      const input=from?builtClient:new URL('../'+source,import.meta.url),target=destination.endsWith('/')?join(dir,destination,basename(source)):join(dir,destination);
      await mkdir(dirname(target),{recursive:true});await cp(input,target,{recursive:true});
    }
  }
  for(const absent of ['node_modules','scripts','tests'])await assert.rejects(access(join(dir,absent)),{code:'ENOENT'});
  const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='http://127.0.0.1:'+port,runtime=await import(pathToFileURL(join(dir,'portal-server.mjs')));
  const created=await runtime.createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false});server=created.server;await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const login=await created.service.login('admin',password);assert.equal(login.state.maintenance.version,1);assert.equal((await created.service.invoke(login.token,'maintenance.list',{})).result.items.length,0);
  for(const path of ['/','/maintenance-ui.js','/maintenance.css','/community-ui.js','/gpuctl.mjs','/guide/queue'])assert.equal((await fetch(origin+path)).status,200,path);
  const artifactReader=await import(pathToFileURL(join(dir,'client-bundle.mjs')));
  assert.equal(await(await fetch(origin+'/gpuctl.mjs')).text(),await artifactReader.standaloneClient(origin));
  assert.ok((await(await fetch(origin+'/guide/queue')).text()).includes('申请系统维修'));
});

test('real bundled approval coexists with shared training, watch, notifications, notes and snapshot reads',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-maintenance-coexist-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),tokenFile=join(dir,'notify-token'),config=join(dir,'notify-config');
  const machine=MACHINES[0].id,calls=[],sent=[],originalFetch=globalThis.fetch;
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(tokenFile,'123456:'+('T'.repeat(32)),{mode:0o600});await writeFile(config,JSON.stringify({tokenFile,chatByUserId:{'builtin-admin':'12345'}}),{mode:0o600});
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,memoryTotalMiB:32768,memoryUsedMiB:0,processesAvailable:true,processes:[]})),gpuq:{connected:true,observeOnly:false,jobs:[],capabilities:['priority-policy-v1','priority-rank-v1','preempt-idle-only-v1','console-yield-v1','console-placement-v1','console-sharing-v1']}}))}));
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='sync')return {state:'RUNNING',nodeJobId:'Jcoexist',assignedIndices:[0]};
    if(operation==='watch')return {state:'UNKNOWN',nodeJobId:'Jcoexist',assignedIndices:[0],progress:{reported:true,stale:false,snapshot:{sequence:1,phase:'train',epochs_completed:1,epochs_total:10,steps_completed:null,steps_total:null,eta_seconds:null,metrics:{},severity:'warning',message:'fixture warning',updated_at:1}}};
    if(operation==='projects.snapshot.info')return {state:'READY',manifestBytes:2,manifestSha256:'a'.repeat(64),totalBytes:0,entries:0};
    assert.ok(operation.startsWith('host.'),'unapproved native operation: '+operation);
    return new Promise((resolve,reject)=>{const child=spawn('python3',[new URL('./maintenance-native-fixture.py',import.meta.url).pathname,dir]);let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>{if(code)reject(Error(err));else try{resolve(JSON.parse(out));}catch(error){reject(error);}});child.stdin.end(JSON.stringify({operation,args}));});
  };
  // The notification sender captures this fake function during initialization;
  // all browser/CLI requests afterwards use the ordinary localhost transport.
  globalThis.fetch=async(url,args)=>{assert.equal(String(url),'https://api.telegram.org/bot123456:'+('T'.repeat(32))+'/sendMessage');sent.push(JSON.parse(args.body));return new Response(JSON.stringify({ok:true}),{status:200});};
  let server,service;
  try{({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath:status,origin,secure:false,bridge,notificationConfigPath:config}));}finally{globalThis.fetch=originalFetch;}
  for(const timer of ['executionTimer','notificationTimer','maintenanceTimer'])clearInterval(service[timer]);
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),owner=(await service.invoke(admin.token,'users.create',{username:'coexist-member',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:owner.id,policyVersion:0});const member=await service.login(owner.username,password);
  const client=join(dir,'gpuctl.mjs'),adminSession=join(dir,'admin-session'),memberSession=join(dir,'member-session'),script=join(dir,'request.sh');
  await writeFile(client,await(await fetch(origin+'/gpuctl.mjs')).text());await writeFile(script,'printf "native fixture\\n"');
  for(const [file,login] of [[adminSession,admin],[memberSession,member]])await writeFile(file,JSON.stringify({url:origin,token:login.token,principal:login.principal,machine}));
  const cli=(args,session=adminSession)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[client,'--session-file',session,'--json',...args]);let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>{try{resolve({code,err,body:out.trim()?JSON.parse(out):null});}catch(error){reject(error);}});child.stdin.end();});
  const training=await cli(['run','--legacy','--rank','P1','--gpu','0','--share','--vram-mib','4096','--','python','fixture.py']);assert.equal(training.code,0,training.err);
  await new Promise(r=>setImmediate(r));while(service.reconciling)await new Promise(r=>setTimeout(r,2));await service.reconcile();
  const job=service.store.jobs[0],before=structuredClone(job);assert.equal(job.state,'RUNNING');assert.equal(usage(service.store.jobs,'builtin-admin'),1);assert.equal(job.spec.placement.shared,true);
  assert.equal((await cli(['notify',job.id,'on'])).code,0);assert.equal((await cli(['note','--general','coexistence note'])).code,0);
  const request=await cli(['maintenance','request','--name','local protocol','--reason','coexistence fixture','--script-file',script,'--cwd',dir],memberSession);assert.equal(request.code,0,request.err);
  const preview=await cli(['maintenance','preview',request.body.data.id]);assert.equal(preview.code,0,preview.err);assert.ok(preview.body.data.impact.platformJobs.some(item=>item.id===job.id));
  const approveArgs=['maintenance','approve',request.body.data.id,'--revision','1','--preview-token',preview.body.data.previewToken];
  const approved=await cli(approveArgs);assert.equal(approved.code,0,approved.err);assert.equal(approved.body.data.result.stdout,'native fixture\n');assert.equal((await cli(approveArgs)).code,0);
  assert.deepEqual(job,before,'maintenance may not rewrite training state or its immutable spec');assert.equal(usage(service.store.jobs,'builtin-admin'),1);assert.equal(calls.filter(call=>call.operation==='host.exec').length,1);
  const statusAfterApproval=service.state(admin.principal);assert.equal(statusAfterApproval.maintenance.version,1);assert.equal(statusAfterApproval.jobs[0].notifications.enabled,true);
  const watched=await cli(['watch',job.id,'--interval','1']);assert.equal(watched.code,3,watched.err);assert.equal(watched.body.state,'UNKNOWN');assert.equal(watched.body.progress.snapshot.epochsCompleted,1);assert.equal(usage(service.store.jobs,'builtin-admin'),1);
  await service.flushJobNotifications();assert.equal(sent.length,1);assert.equal(sent[0].chat_id,'12345');assert.doesNotMatch(sent[0].text,/native fixture|local protocol/);
  assert.ok((await cli(['notes'])).body.data.notes.some(note=>note.body==='coexistence note'));
  await service.invoke(member.token,'projects.snapshot.info',{machine,project:'fixture',release:'a'.repeat(64)});
  assert.equal(calls.at(-1).args.userId,owner.id);assert.equal(calls.filter(call=>call.operation==='host.exec').length,1);
  assert.equal((await cli(['maintenance','show',request.body.data.id],memberSession)).body.data.state,'SUCCEEDED');
});
