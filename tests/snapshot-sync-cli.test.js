import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {standaloneClient} from '../client-bundle.mjs';
import {campusTLSFixture} from './campus-upload-fixture.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),run=promisify(execFile),chunk=1024**2;
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'gpuq-sync-cli-')),repo=join(root,'repo 工作区'),session=join(root,'session'),client=join(root,'gpuctl.mjs'),calls=[],files=new Map();await mkdir(repo);await writeFile(client,await standaloneClient());
  await run('git',['init',repo]);
  // Exercise the Windows Git defaults on every CI OS, without global config changes.
  await run('git',['-C',repo,'config','core.autocrlf','true']);await run('git',['-C',repo,'config','core.eol','crlf']);
  await writeFile(join(repo,'train.py'),'print("train")\n');await run('git',['-C',repo,'add','train.py']);await run('git',['-C',repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  const payload=Buffer.alloc(chunk+13,123),dataManifest=Buffer.from(JSON.stringify({schema:1,directories:[],files:[{path:'samples.bin',size:payload.length,sha256:hash(payload)}]})),version=hash(dataManifest);
  const published=Buffer.from('published code'),codeManifest=Buffer.from(JSON.stringify({schema:1,directories:[],files:[{path:'train.py',size:published.length,sha256:hash(published),executable:false}]}));
  let target=null,manifest=Buffer.alloc(0),parsed=null,drop=false,upload=null;
  const tls=await campusTLSFixture(async(req,res)=>{let raw='';for await(const bytes of req)raw+=bytes;const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});res.setHeader('Content-Type','application/json');let result;
    try{
      if(operation==='state'){res.end(JSON.stringify({state:{demo:false,gpuqConnected:true,machines:[{id:'gpu-1'},{id:'gpu-2'}],users:[],jobs:[]}}));return;}
      if(operation==='projects.list')result={projects:target?[{project:'copy'}]:[]};
      else if(operation==='projects.snapshot.info')result={state:'READY',manifestBytes:codeManifest.length,manifestSha256:hash(codeManifest),totalBytes:published.length,entries:1};
      else if(operation==='projects.snapshot.manifest')result={data:codeManifest.toString('base64'),offset:codeManifest.length,size:codeManifest.length,eof:true};
      else if(operation==='projects.snapshot.get')result={data:published.subarray(args.offset,args.offset+chunk).toString('base64'),offset:published.length,size:published.length,eof:true};
      else if(operation==='datasets.list')result={datasets:[]};
      else if(operation==='datasets.snapshot.info')result={state:'READY',manifestBytes:dataManifest.length,manifestSha256:hash(dataManifest),totalBytes:payload.length,entries:1};
      else if(operation==='datasets.snapshot.manifest')result={data:dataManifest.subarray(args.offset,args.offset+chunk).toString('base64'),offset:dataManifest.length,size:dataManifest.length,eof:true};
      else if(operation==='datasets.snapshot.get'){const bytes=payload.subarray(args.offset,args.offset+chunk);result={data:bytes.toString('base64'),size:payload.length,offset:args.offset+bytes.length};}
      else if(operation==='projects.sync.begin'){if(!target)target={state:'RECEIVING_MANIFEST',key:args.key,manifestOffset:0,manifestSha256:args.manifestSha256,project:args.project,source:args.source};else assert.equal(args.key,target.key);result=target;}
      else if(operation==='projects.sync.manifest'){const bytes=Buffer.from(args.data,'base64');assert.equal(args.offset,manifest.length);manifest=Buffer.concat([manifest,bytes]);target.manifestOffset=manifest.length;result={offset:manifest.length};}
      else if(operation==='projects.sync.seal'){assert.equal(hash(manifest),target.manifestSha256);parsed=JSON.parse(manifest);target.state='COPYING';result=target;}
      else if(operation==='projects.sync.status'){assert.equal(args.key,target.key);result={...target};if(args.path){const entry=parsed.files.find(e=>e.path===args.path),bytes=files.get(args.path);result.file={...entry,offset:bytes?.length||0,complete:!!bytes&&bytes.length===entry.size};}}
      else if(operation==='projects.sync.chunk'){const before=files.get(args.path)||Buffer.alloc(0),bytes=Buffer.from(args.data,'base64');assert.equal(args.offset,before.length);files.set(args.path,Buffer.concat([before,bytes]));if(drop){drop=false;throw Error('Reply lost after durable write');}result={offset:before.length+bytes.length,complete:files.get(args.path).length===parsed.files.find(e=>e.path===args.path).size};}
      else if(operation==='projects.sync.finish'){for(const entry of parsed.files)assert.equal(hash(files.get(entry.path)),entry.sha256);target.state='CODE_READY';result=target;}
      else if(operation==='datasets.upload.begin'){upload??={uploadId:'44444444-4444-4444-8444-444444444444',state:'RECEIVING_MANIFEST',manifestOffset:0};result=upload;}
      else if(operation==='datasets.upload.manifest'){upload.manifestOffset+=Buffer.from(args.data,'base64').length;result={offset:upload.manifestOffset};}
      else if(operation==='datasets.upload.seal'){upload.state='UPLOADING';result=upload;}
      else if(operation==='datasets.upload.status'){result={...upload};if(args.path){const bytes=files.get(args.path);result.file={...JSON.parse(dataManifest).files[0],offset:bytes?.length||0,complete:bytes?.length===payload.length};}}
      else if(operation==='datasets.upload.chunk'){const before=files.get(args.path)||Buffer.alloc(0),bytes=Buffer.from(args.data,'base64');assert.equal(args.offset,before.length);files.set(args.path,Buffer.concat([before,bytes]));if(drop){drop=false;throw Error('Reply lost after durable write');}result={offset:before.length+bytes.length,complete:before.length+bytes.length===payload.length};}
      else if(operation==='datasets.upload.commit'){assert.deepEqual(files.get('samples.bin'),payload);upload={...upload,state:'READY',dataset:'u-fixture-data',version};result=upload;}
      else throw Error('Unexpected operation: '+operation);
      res.end(JSON.stringify({result}));
    }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
  },{machine:'gpu-2'});const server=createServer(tls.control);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;await writeFile(session,JSON.stringify({url,token:'fixture-only',principal:{userId:'demo-user-1',username:'alice',role:'member'}}));
  const cli=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[client,'--url',url,'--session-file',session,'--json',...args]);let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.on('error',reject);child.on('close',code=>resolve({code,stderr,data:stdout?JSON.parse(stdout).data:null}));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await tls.close();assert.equal(tls.counters.portalFileRequests,0);await rm(root,{recursive:true,force:true});});return {repo,cli,calls,files,version,drop:()=>drop=true};
}
test('Git preview leaves target unchanged; clean commit copies code into a fenced new draft and resumes a lost reply',async t=>{
  const f=await fixture(t),args=['sync','git',f.repo,'--to','gpu-2','--project','copy','--ref','HEAD'];const preview=await f.cli([...args,'--dry-run']);assert.equal(preview.code,0,preview.stderr);assert.equal(preview.data.changes,false);assert.equal(f.calls.some(c=>c.operation==='projects.sync.begin'),false);
  f.drop();assert.equal((await f.cli(args)).code,1);const resumed=await f.cli(args);assert.equal(resumed.code,0,resumed.stderr);assert.equal(resumed.data.state,'CODE_READY');assert.match(resumed.data.source.commit,/^[a-f0-9]{40}$/);assert.deepEqual(f.files.get('train.py'),(await run('git',['-C',f.repo,'cat-file','blob',resumed.data.source.commit+':train.py'],{encoding:'buffer'})).stdout);assert.equal(f.calls.some(c=>/publish|terminal|host\.exec/.test(c.operation)),false);assert.equal((await run('git',['-C',f.repo,'status','--porcelain'])).stdout,'');
});
test('dirty Git and implicit/unauthorized targets fail before starting sync',async t=>{
  const f=await fixture(t);await writeFile(join(f.repo,'train.py'),'uncommitted');for(const extras of [[],['--to','auto'],['--to','gpu-9'],['--to','gpu-2']])assert.equal((await f.cli(['sync','git',f.repo,'--project','copy',...extras])).code,1);assert.equal(f.calls.some(c=>c.operation==='projects.sync.begin'),false);
});
test('Git sync resolves an explicit historical commit rather than current HEAD or local draft bytes',async t=>{
  const f=await fixture(t),commit=(await run('git',['-C',f.repo,'rev-parse','HEAD'])).stdout.trim(),original=(await run('git',['-C',f.repo,'cat-file','blob',commit+':train.py'],{encoding:'buffer'})).stdout;
  await writeFile(join(f.repo,'train.py'),'print("new HEAD")\n');await run('git',['-C',f.repo,'add','train.py']);await run('git',['-C',f.repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','new head']);
  const result=await f.cli(['sync','git',f.repo,'--to','gpu-2','--project','copy','--ref',commit]);
  assert.equal(result.code,0,result.stderr);assert.equal(result.data.source.commit,commit);assert.deepEqual(f.files.get('train.py'),original);
  assert.notDeepEqual(f.files.get('train.py'),await readFile(join(f.repo,'train.py')));
});
test('Git sync preserves fixed executable modes despite local archive permissions',async t=>{
  const f=await fixture(t),script='启动 train.sh';await writeFile(join(f.repo,script),'#!/bin/sh\necho training\n');
  await run('git',['-C',f.repo,'config','core.filemode','false']);await run('git',['-C',f.repo,'add',script]);
  await run('git',['-C',f.repo,'update-index','--chmod=+x',script]);
  await run('git',['-C',f.repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','executable entry']);
  // Git tree mode is portable; extraction mode is not (including Windows).
  await run('git',['-C',f.repo,'config','tar.umask','0111']);
  const result=await f.cli(['sync','git',f.repo,'--to','gpu-2','--project','copy']);assert.equal(result.code,0,result.stderr);
  const manifest=JSON.parse(Buffer.concat(f.calls.filter(c=>c.operation==='projects.sync.manifest').map(c=>Buffer.from(c.args.data,'base64'))));
  assert.equal(manifest.files.find(file=>file.path===script).executable,true);
  assert.equal(manifest.files.find(file=>file.path==='train.py').executable,false);
  assert.deepEqual(f.files.get(script),(await run('git',['-C',f.repo,'cat-file','blob',result.data.source.commit+':'+script],{encoding:'buffer'})).stdout);
});
test('Git sync rejects effective archive transformations in the fixed historical commit before any target write',async t=>{
  for(const [attribute,rule] of [['export-ignore','private export-ignore'],['export-ignore','private/ export-ignore'],['export-subst','private/*.txt export-subst']])await t.test(rule,async t=>{
    const f=await fixture(t);await mkdir(join(f.repo,'private'));await writeFile(join(f.repo,'private','selected.txt'),'private code\n');
    await writeFile(join(f.repo,'.gitattributes'),rule+'\n');
    await run('git',['-C',f.repo,'add','.']);await run('git',['-C',f.repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','archive rules']);
    const commit=(await run('git',['-C',f.repo,'rev-parse','HEAD'])).stdout.trim();
    await writeFile(join(f.repo,'.gitattributes'),'');await run('git',['-C',f.repo,'add','.gitattributes']);await run('git',['-C',f.repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','new head without rules']);
    const result=await f.cli(['sync','git',f.repo,'--to','gpu-2','--project','copy','--ref',commit]);
    assert.equal(result.code,1);assert.match(result.stderr,new RegExp(attribute));assert.equal(f.calls.some(c=>c.operation==='projects.sync.begin'),false);
  });
});
test('Git sync does not take archive rules from a newer working tree or allow local attribute overrides',async t=>{
  const f=await fixture(t),commit=(await run('git',['-C',f.repo,'rev-parse','HEAD'])).stdout.trim();
  await writeFile(join(f.repo,'.gitattributes'),'train.py export-ignore\n');await run('git',['-C',f.repo,'add','.gitattributes']);await run('git',['-C',f.repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','new head excludes file']);
  const args=['sync','git',f.repo,'--to','gpu-2','--project','copy','--ref',commit],result=await f.cli(args);
  assert.equal(result.code,0,result.stderr);assert.deepEqual(f.files.get('train.py'),(await run('git',['-C',f.repo,'cat-file','blob',commit+':train.py'],{encoding:'buffer'})).stdout);
  await writeFile(join(f.repo,'.git','info','attributes'),'train.py -export-ignore\n');
  const before=f.calls.length,blocked=await f.cli(['sync','git',f.repo,'--to','gpu-2','--project','copy']);assert.equal(blocked.code,1);assert.match(blocked.stderr,/info\/attributes/);assert.equal(f.calls.slice(before).some(c=>c.operation==='projects.sync.begin'),false);
});
test('explicit source node and full release copy code while retaining source provenance',async t=>{
  const f=await fixture(t),release='a'.repeat(64),result=await f.cli(['sync','code','--from','gpu-1','--to','gpu-2','--project','vision','--target-project','copy','--release',release]);assert.equal(result.code,0,result.stderr);assert.equal(result.data.state,'CODE_READY');assert.deepEqual(result.data.source,{kind:'release',machine:'gpu-1',project:'vision',release});assert.equal(f.files.get('train.py').toString(),'published code');assert.equal(f.calls.filter(c=>c.operation.startsWith('projects.snapshot')).every(c=>c.args.machine==='gpu-1'&&c.args.release===release),true);assert.equal(f.calls.filter(c=>c.operation.startsWith('projects.sync')).every(c=>c.args.machine==='gpu-2'),true);
});
test('selected-node data transfer uses existing resumable upload and confirms the source content version',async t=>{
  const f=await fixture(t),args=['sync','data','source@'+f.version,'--from','gpu-1','--to','gpu-2','--name','data'];const preview=await f.cli([...args,'--dry-run']);assert.equal(preview.code,0,preview.stderr);assert.equal(f.calls.some(c=>c.operation==='datasets.upload.begin'),false);f.drop();assert.equal((await f.cli(args)).code,1);assert.equal(f.calls.find(c=>c.operation==='datasets.upload.begin').args.key,preview.data.key,'preview shows the actual durable retry key');const start=f.calls.length,result=await f.cli(args);assert.equal(result.code,0,result.stderr);assert.equal(result.data.version,f.version);const resumed=f.calls.slice(start).find(c=>c.operation==='datasets.upload.chunk');assert.equal(resumed.args.offset,chunk);assert.equal(f.calls.some(c=>c.operation==='datasets.unregister'),false);
});
