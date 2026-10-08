// Disposable HTTPS portal + dataset-upload-v1 node. No production access.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),CHUNK=1024**2,LIMIT=256*1024**2;
const root=resolve(new URL('../dist/',import.meta.url).pathname);
export async function directBrowserFixture(machines){
  const directory=await mkdtemp(join(tmpdir(),'browser-upload-tls-')),key=join(directory,'key.pem'),certificate=join(directory,'certificate.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certificate,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  const tls={key:await readFile(key),cert:await readFile(certificate)},certificateSha256=hash(execFileSync('openssl',['x509','-in',certificate,'-outform','DER']));
  const calls=[],raw=[],probes=[],preflights=[],failures=[],uploads=new Map(),tickets=new Map(),names=new Map(),admissions=new Map();
  const config={mode:'success',holdChunk:false,holdPublish:false,deny:false,mismatch:false};
  let nodeOrigin,origin,releaseChunk,heldChunk=false,expired=false,dropped=false,ticketCount=0;
  const describe=upload=>({uploadId:upload.id,name:upload.name,state:upload.state,placementProtocol:1,requestedMachine:upload.requestedMachine??upload.spec.machine,storageMachine:machines[0].id,storageTier:'hdd',legacyPlacement:false,manifestOffset:upload.manifest.length,manifestBytes:upload.spec.manifestBytes,totalBytes:upload.spec.totalBytes,entries:upload.spec.entries,chunkBytes:CHUNK,
    ...(upload.dataset?{dataset:upload.dataset,version:upload.version}:{})});
  const status=(upload,path)=>{
    if(upload.state==='PUBLISHING'&&!config.holdPublish)upload.state='READY';
    const result=describe(upload);
    if(config.mismatch&&upload.state==='READY')result.totalBytes++;
    if(path!==undefined){const entry=upload.parsed.files.find(file=>file.path===path),bytes=upload.files.get(path);assert.ok(entry);result.file={...entry,offset:bytes?.length||0,complete:!!bytes&&bytes.length===entry.size};}
    return result;
  };
  const write=(upload,action,{offset,path},bytes)=>{
    assert.ok(bytes.length<=CHUNK);const old=action==='manifest'?upload.manifest:upload.files.get(path)||Buffer.alloc(0);
    if(offset<old.length&&offset+bytes.length<=old.length){assert.deepEqual(old.subarray(offset,offset+bytes.length),bytes,'A duplicate chunk must match durable bytes');return {...describe(upload),offset:old.length,complete:action==='chunk'&&old.length===upload.parsed.files.find(file=>file.path===path).size};}
    assert.equal(offset,old.length,'Only node-confirmed offsets may resume');
    if(action==='chunk')assert.ok(upload.parsed.files.some(file=>file.path===path&&offset+bytes.length<=file.size));
    const next=Buffer.concat([old,bytes]);if(action==='manifest')upload.manifest=next;else upload.files.set(path,next);
    return {...describe(upload),offset:next.length,complete:action==='chunk'&&next.length===upload.parsed.files.find(file=>file.path===path).size};
  };
  const reply=(res,statusCode,body)=>{res.writeHead(statusCode,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  const node=createServer(tls,async(req,res)=>{
    try{
      const allowedOrigin=config.portalOrigin??origin;
      res.setHeader('Access-Control-Allow-Origin',allowedOrigin);res.setHeader('Vary','Origin');
      assert.equal(req.headers.origin,allowedOrigin,'Only the fixture portal may reach the node');
      assert.equal(req.headers.cookie,undefined,'Portal cookies must never reach the node');
      if(req.method==='OPTIONS'){
        preflights.push({method:req.headers['access-control-request-method'],headers:req.headers['access-control-request-headers']});
        res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Private-Network','true');res.writeHead(204);return res.end();
      }
      const url=new URL(req.url,nodeOrigin);
      if(url.pathname==='/capabilities'){assert.equal(req.method,'GET');assert.equal(req.headers.authorization,undefined);probes.push({method:req.method,cookie:false});return reply(res,200,{protocol:'dataset-upload-v1',machine:machines[0].id,revision:'a'.repeat(64),listenerReady:config.mode!=='unavailable'});}
      const parts=url.pathname.split('/'),id=parts[3],action=parts[4],ticket=tickets.get(req.headers.authorization),upload=uploads.get(id);
      raw.push({uploadId:id,action,path:url.searchParams.get('path'),offset:url.searchParams.has('offset')?Number(url.searchParams.get('offset')):null,method:req.method,cookie:false});
      if(!ticket||ticket.uploadId!==id||!upload||ticket.owner!==upload.owner)return reply(res,401,{ok:false});
      if(config.mode==='expire'&&action==='chunk'&&!expired){expired=true;tickets.delete(req.headers.authorization);return reply(res,401,{ok:false});}
      if(config.mode==='network'&&action==='manifest'){req.resume();return res.destroy();}
      if(action==='status')return reply(res,200,{ok:true,result:status(upload,url.searchParams.has('path')?url.searchParams.get('path'):undefined)});
      assert.equal(req.method,'POST');assert.equal(req.headers['content-type'],'application/octet-stream');
      const chunks=[];let length=0;for await(const bytes of req){length+=bytes.length;assert.ok(length<=CHUNK);chunks.push(bytes);}
      const result=write(upload,action,{offset:Number(url.searchParams.get('offset')),path:url.searchParams.get('path')},Buffer.concat(chunks));
      raw.at(-1).bytes=length;
      if(config.mode==='drop'&&action==='chunk'&&length&&!dropped){dropped=true;res.writeHead(200,{'Content-Type':'application/json','Content-Length':'128'});res.write('{"ok":');res.flushHeaders();setImmediate(()=>res.destroy());return;}
      if(config.holdChunk&&action==='chunk'&&length&&!heldChunk){heldChunk=true;await new Promise(resolve=>{releaseChunk=resolve;});}
      reply(res,200,{ok:true,result:config.mode==='bad-ack'&&action==='chunk'?{...result,offset:result.offset+1}:result});
    }catch(error){failures.push(error.message);if(!res.destroyed)reply(res,500,{ok:false,error:'Fixture protocol assertion failed'});}
  });
  const portal=createServer(tls,async(req,res)=>{
    try{
      const url=new URL(req.url,origin);
      if(url.pathname==='/api/call'){
        const body=[];for await(const bytes of req)body.push(bytes);const {operation,args}=JSON.parse(Buffer.concat(body)),owner=req.headers.cookie?.match(/portal_fixture=([^;]+)/)?.[1];
        assert.ok(owner,'Portal requests must carry their own HttpOnly session cookie');
        calls.push({operation,args:structuredClone(args),owner});
        assert.equal('userId' in args||'hostAdmin' in args||'owners' in args,false);
        if(config.deny)return reply(res,403,{error:'这台服务器未授权'});
        if(operation==='cloud.info')return reply(res,200,{result:{capabilityVerified:false,configurationEnabled:true}});
        if(operation==='datasets.capacity')return reply(res,200,{result:{machine:args.machine,available:true,filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3}});
        if(operation==='datasets.catalog')return reply(res,200,{result:{checkedAt:Date.now()/1000,machine:args.machine,machines:machines.map(row=>({machine:row.id,state:'ok'})),datasets:[...uploads.values()].filter(upload=>upload.owner===owner&&upload.state==='READY').map(upload=>({dataset:upload.dataset,name:upload.name,versions:[{version:upload.version,state:'READY',bytes:upload.spec.totalBytes,files:upload.parsed.files.length,canUse:true,canPrepare:false,ownerLabel:'所属用户：本地验收',locations:[{machine:upload.spec.machine,dataset:upload.dataset,state:'READY',canUse:true,canPrepare:false}]}]}))}});
        if(operation==='datasets.overview'){assert.deepEqual(args,{});return reply(res,200,{result:{protocol:0}});}
        assert.equal(args.machine,machines[0].id);
        if(operation==='datasets.upload.routes')return reply(res,200,{result:{available:true,protocol:'dataset-upload-v1',machine:args.machine,revision:'a'.repeat(64),certificateSha256,routes:[{id:'primary',kind:'campus-direct',endpoint:nodeOrigin}]}});
        if(operation==='datasets.label.get'){const label=names.get(owner+':'+args.dataset)||{displayName:null,revision:0};return reply(res,200,{result:{dataset:args.dataset,...label,name:label.displayName??args.dataset,scope:'personal',ownerId:owner}});}
        if(operation==='datasets.label.set'){const old=names.get(owner+':'+args.dataset)||{revision:0};assert.equal(args.revision,old.revision);const label={displayName:args.displayName,revision:old.revision+1};names.set(owner+':'+args.dataset,label);return reply(res,200,{result:{dataset:args.dataset,...label,name:label.displayName,scope:'personal',ownerId:owner}});}
        if(operation==='datasets.upload.admission.create'||operation==='datasets.upload.admission.status'){
          const key=owner+':'+args.key;let receipt=admissions.get(key);
          if(operation.endsWith('.create')){const specification=Object.fromEntries(['name','manifestBytes','manifestSha256','totalBytes','entries'].map(field=>[field,args[field]]));if(!receipt){receipt={protocol:'dataset-upload-admission-v1',key:args.key,uploadId:randomUUID(),requestedMachine:args.machine,storageMachine:machines[0].id,storageTier:'hdd',specification,state:'ISSUED'};admissions.set(key,receipt);}assert.deepEqual(receipt.specification,specification);}
          assert.ok(receipt,'Original owner-scoped admission must exist');return reply(res,200,{result:receipt});
        }
        const action=operation.split('.').at(-1);let upload;
        if(action==='begin'){
          const receipt=[...admissions.entries()].find(([key,row])=>key.startsWith(owner+':')&&row.uploadId===args.key)?.[1];assert.ok(receipt,'Begin requires this owner’s server-issued UUID');assert.deepEqual(Object.fromEntries(['name','manifestBytes','manifestSha256','totalBytes','entries'].map(field=>[field,args[field]])),receipt.specification);
          upload=uploads.get(args.key);if(upload&&upload.owner!==owner)return reply(res,403,{error:'不能读取其他账号的上传'});
          if(!upload){upload={id:args.key,owner,name:args.name,spec:structuredClone(args),state:'RECEIVING_MANIFEST',manifest:Buffer.alloc(0),files:new Map()};uploads.set(upload.id,upload);}
          return reply(res,200,{result:{...describe(upload),uploadTransport:{protocol:'dataset-upload-v1',directAvailable:config.mode!=='unavailable',reason:config.mode==='unavailable'?'not-configured':'ready',relayLimitBytes:LIMIT,relayAllowed:args.allowRelay===true}}});
        }
        upload=uploads.get(args.uploadId);if(!upload||upload.owner!==owner)return reply(res,403,{error:'不能读取其他账号的上传'});
        if(action==='direct-ticket'){
          const ticket='fixture-only-'+randomUUID();tickets.set('Bearer '+ticket,{owner,uploadId:upload.id});ticketCount++;
          return reply(res,200,{result:{available:true,protocol:'dataset-upload-v1',endpoint:nodeOrigin,ticket,expiresAt:Math.floor(Date.now()/1000)+300,certificateSha256,chunkBytes:CHUNK}});
        }
        if(action==='status')return reply(res,200,{result:status(upload,args.path)});
        if(action==='seal'){
          assert.equal(hash(upload.manifest),upload.spec.manifestSha256);upload.parsed=JSON.parse(upload.manifest);
          assert.equal(upload.parsed.files.length+upload.parsed.directories.length,upload.spec.entries);assert.equal(upload.parsed.files.reduce((sum,row)=>sum+row.size,0),upload.spec.totalBytes);
          upload.state='UPLOADING';return reply(res,200,{result:describe(upload)});
        }
        if(action==='commit'){
          for(const file of upload.parsed.files){const bytes=upload.files.get(file.path);assert.ok(bytes);assert.equal(bytes.length,file.size);assert.equal(hash(bytes),file.sha256);}
          upload.dataset='u-'+hash(owner).slice(0,16)+'-'+upload.name;upload.version=hash(upload.manifest);upload.state='PUBLISHING';
          if(config.mode==='commit-drop'){res.writeHead(200,{'Content-Type':'application/json','Content-Length':'128'});res.write('{"result":');res.flushHeaders();setImmediate(()=>res.destroy());return;}return reply(res,200,{result:describe(upload)});
        }
        if(action==='manifest'||action==='chunk'){
          if(upload.spec.totalBytes>LIMIT&&upload.spec.allowRelay!==true)return reply(res,403,{error:'需要明确中转同意'});
          return reply(res,200,{result:write(upload,action,args,Buffer.from(args.data,'base64'))});
        }
        throw Error('Unexpected portal operation '+operation);
      }
      if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
      if(url.pathname==='/'){
        res.writeHead(200,{'Content-Type':'text/html'});return res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>STARGATE · 数据集</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/copy-help.css"><link rel="stylesheet" href="/dataset-flow.css"><link rel="stylesheet" href="/dataset-warehouse.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/workbench.css"><link rel="stylesheet" href="/datasets.css"></head><body class="sb" data-room="datasets"><header class="app-header"><span class="wordmark" aria-label="STARGATE"></span><span>STARGATE</span></header><main><div class="page-heading"><h1 id="page-title">数据集</h1><div class="heading-actions"></div></div><section id="page-datasets"></section><button data-nav="work" hidden>工作台</button></main></body></html>`);
      }
      const path=resolve(root,'.'+url.pathname);assert.ok(path.startsWith(root+sep));
      const content=await readFile(path);res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.woff2')?'font/woff2':path.endsWith('.svg')?'image/svg+xml':'application/octet-stream'});res.end(content);
    }catch(error){failures.push(error.message);if(!res.destroyed)reply(res,500,{error:'Fixture assertion failed'});}
  });
  for(const server of [node,portal])server.on('tlsClientError',()=>{});
  await new Promise(resolve=>node.listen(0,'127.0.0.1',resolve));nodeOrigin='https://127.0.0.1:'+node.address().port;
  await new Promise(resolve=>portal.listen(0,'127.0.0.1',resolve));origin='https://127.0.0.1:'+portal.address().port;
  return {origin,nodeOrigin,certificateSha256,calls,raw,probes,preflights,failures,uploads,config,
    authorize(owner,uploadId){assert.equal(uploads.get(uploadId)?.owner,owner);const ticket='fixture-only-'+randomUUID();tickets.set('Bearer '+ticket,{owner,uploadId});ticketCount++;return ticket;},
    get tickets(){return ticketCount;},get held(){return typeof releaseChunk==='function';},release(){releaseChunk?.();releaseChunk=null;},
    async close(){releaseChunk?.();for(const server of [portal,node]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(directory,{recursive:true,force:true});}};
}
