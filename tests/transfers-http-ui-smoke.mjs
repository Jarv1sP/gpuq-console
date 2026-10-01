// True Portal/SQLite/cookies, downloaded bundled CLI, Chromium and local files.
// Bridge/storage are disposable in-memory fixtures; no SSH, GPUs or production.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),password='Transfer-HTTP-Browser-Fixture-2026!';
const dir=await mkdtemp(join(tmpdir(),'gpuq-transfer-http-ui-')),reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
let server,service,browser;const calls=[],receipts=new Map(),uploads=new Map(),errors=[];
const data=Buffer.alloc(2*1024**2+13,17),manifest=Buffer.from(JSON.stringify({directories:[],files:[{path:'train.bin',sha256:hash(data),size:data.length}],schema:1})),version=hash(manifest),info={state:'READY',manifestBytes:manifest.length,manifestSha256:version,totalBytes:data.length,entries:1};
try{
  const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const uploadView=u=>({uploadId:u.id,state:u.state,manifestOffset:u.manifest.length,totalBytes:u.spec.totalBytes,remainingBytes:u.spec.totalBytes-[...u.files.values()].reduce((n,b)=>n+b.length,0),...(u.state==='READY'?{dataset:'u-fixture-'+u.spec.name,version:hash(u.manifest)}:{})});
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:async(machine,op,args)=>{
    calls.push({machine,op,args});
    if(op==='transfers.source.prepare')return {id:args.id,token:'x'.repeat(43),...info};
    if(op==='transfers.start'){if(!receipts.has(args.id))receipts.set(args.id,{id:args.id,state:'RUNNING',bytes:123,totalBytes:data.length});return receipts.get(args.id);}
    if(op==='transfers.cancel'){receipts.get(args.id).state='CANCELED';return receipts.get(args.id);}
    if(op==='transfers.status'||op==='transfers.resume')return receipts.get(args.id);
    if(op==='datasets.snapshot.info')return info;
    if(op==='datasets.snapshot.manifest'||op==='datasets.snapshot.get'){const bytes=op.endsWith('manifest')?manifest:data,part=bytes.subarray(args.offset,args.offset+1024**2);return {data:part.toString('base64'),offset:args.offset+part.length,size:bytes.length,eof:args.offset+part.length===bytes.length};}
    if(op==='datasets.list')return {datasets:[]};
    if(op==='datasets.upload.begin'){if(!uploads.has(args.key))uploads.set(args.key,{id:args.key,state:'RECEIVING_MANIFEST',spec:args,manifest:Buffer.alloc(0),files:new Map()});return uploadView(uploads.get(args.key));}
    if(op.startsWith('datasets.upload.')){
      const u=uploads.get(args.uploadId),action=op.split('.').at(-1);assert.ok(u);
      if(action==='manifest'){const part=Buffer.from(args.data,'base64');assert.equal(args.offset,u.manifest.length);u.manifest=Buffer.concat([u.manifest,part]);return {...uploadView(u),offset:u.manifest.length};}
      if(action==='seal'){u.state='UPLOADING';u.entries=JSON.parse(u.manifest).files;return uploadView(u);}
      if(action==='status'){const result=uploadView(u);if(args.path){const entry=u.entries.find(f=>f.path===args.path),bytes=u.files.get(args.path);result.file={...entry,offset:bytes?.length||0,complete:bytes!==undefined&&bytes.length===entry.size};}return result;}
      if(action==='chunk'){const before=u.files.get(args.path)||Buffer.alloc(0),part=Buffer.from(args.data,'base64');assert.equal(before.length,args.offset);u.files.set(args.path,Buffer.concat([before,part]));return {...uploadView(u),offset:before.length+part.length,complete:true};}
      if(action==='commit'){for(const entry of u.entries)assert.equal(hash(u.files.get(entry.path)),entry.sha256);u.state='READY';return uploadView(u);}
      if(action==='pause')return uploadView(u);
    }throw Error('Unexpected bridge operation '+op);
  }}));await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'transfer-member',password})).result;await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});const login=await service.login(member.username,password),session=join(dir,'session.json');await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal,machine:'gpu-1'}));
  const cliFile=join(dir,'gpuctl.mjs');await writeFile(cliFile,await (await fetch(origin+'/gpuctl.mjs')).text());
  const cli=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cliFile,'--session-file',session,'--json',...args]);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',code=>{if(code)reject(Error(err));else resolve(JSON.parse(out).data);});child.stdin.end();});
  await mkdir(join(dir,'local'));await writeFile(join(dir,'local/train.bin'),data);const uploaded=await cli(['transfer','upload',join(dir,'local'),'--name','cli-data']);assert.ok(uploaded.transferId);assert.equal(uploaded.state,'READY');assert.equal((await cli(['transfer','status',uploaded.transferId])).state,'SUCCEEDED');
  const download=await cli(['transfer','download','shared@'+version,join(dir,'download')]);assert.deepEqual(await readFile(join(dir,'download/train.bin')),data);assert.equal(download.state,'SUCCEEDED');
  const copied=await cli(['transfer','copy','shared@'+version,'--from','gpu-1','--to','gpu-2','--name','cli-copy','--detach']);assert.equal(copied.state,'RUNNING');assert.equal((await cli(['transfer','cancel',copied.id])).state,'CANCELED');assert.equal((await cli(['transfer','list'])).transfers.length,3);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.locator('#login-form [name=username]').fill(member.username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=transfers]').click();await page.locator('#transfer-copy-form').waitFor();
  await page.locator('#transfer-copy-form [name=transfer-from]').selectOption('gpu-1');await page.locator('#transfer-copy-form [name=transfer-machine]').selectOption('gpu-2');await page.locator('#transfer-copy-form [name=transfer-reference]').fill('shared@'+version);await page.locator('#transfer-copy-form [name=transfer-name]').fill('browser-copy');await page.locator('#transfer-copy-form [type=submit]').click();await page.locator('#transfer-list article').filter({hasText:'browser-copy'}).waitFor();
  const entry=page.locator('#transfer-list article').filter({hasText:'browser-copy'});await entry.locator('[data-transfer-action=status]').click();page.once('dialog',d=>d.accept());await entry.locator('[data-transfer-action=cancel]').click();await entry.filter({hasText:'CANCELED'}).waitFor();
  await page.locator('[data-nav=datasets]').click();await page.locator('[name=dataset-name]').fill('browser-upload');await page.locator('[name=dataset-directory]').setInputFiles(join(dir,'local'));await page.locator('#dataset-upload-start').click();await page.locator('#dataset-upload-status').filter({hasText:'本机已就绪'}).waitFor();await page.locator('[data-nav=transfers]').click();await page.locator('#transfer-refresh').click();await page.locator('#transfer-list article').filter({hasText:'browser-upload'}).waitFor();
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'transfer page overflows mobile width');assert.deepEqual(errors,[]);assert.ok(calls.every(c=>c.args.userId===member.id),'identity is derived from authenticated owner');assert.equal(service.store.jobs.length,0);
  console.log('Transfers HTTP/CLI/Chromium passed: upload, download bytes, background copy, list/status/cancel, shared browser upload, mobile and owner isolation.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));else service?.close();await rm(dir,{recursive:true,force:true});}
