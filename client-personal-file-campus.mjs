import {request as httpsRequest} from 'node:https';
import {pinnedUploadAgent} from './client-direct-upload.mjs';
import {downloadFile} from './client-file-download.mjs';

const PROTOCOL='personal-file-campus-v1',CHUNK=1024**2;
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=message=>{throw Error(message);};
export function personalFileGrant(value,path,action,now=Date.now()/1000){
  if(!value||value.available!==true||value.protocol!==PROTOCOL||value.kind!=='campus-direct'||value.routeId!=='primary'
    ||!UUID.test(value.grantId||'')||!HASH.test(value.certificateSha256||'')||!HASH.test(value.revision||'')
    ||value.chunkBytes!==CHUNK||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+301
    ||typeof value.ticket!=='string'||! /^[A-Za-z0-9_.-]{20,4096}$/.test(value.ticket))fail('Node did not confirm strict campus personal-file authorization; no relay was attempted');
  let endpoint;try{endpoint=new URL(value.endpoint);}catch{fail('Invalid campus file endpoint');}
  if(endpoint.protocol!=='https:'||endpoint.origin!==value.endpoint||endpoint.pathname!=='/'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)fail('Campus files require one fixed HTTPS origin');
  if(action==='get'&&(!value.file||value.file.protocol!==2||value.file.path!==path||!HASH.test(value.file.fingerprint||'')
    ||!Number.isSafeInteger(value.file.size)||value.file.size<0))fail('Node did not confirm the exact download source');
  return value;
}

export function personalFileRequest(grant,agent,action,args,{request=httpsRequest,timeoutMs=30000}={}){
  if(!['get','put'].includes(action)||!Number.isSafeInteger(args.offset)||args.offset<0)fail('Invalid campus file request');
  const writing=action==='put',target=new URL(`/v1/files/${grant.grantId}/${action}`,grant.endpoint);
  target.searchParams.set('offset',String(args.offset));
  if(writing){
    if(typeof args.final!=='boolean'||!Buffer.isBuffer(args.bytes)||args.bytes.length>CHUNK)fail('Invalid campus file chunk');
    target.searchParams.set('final',String(args.final));
  }
  return new Promise((resolve,reject)=>{
    let req,timer,done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);if(error){req?.destroy();reject(error);}else resolve(result);};
    try{
      req=request(target,{agent,method:writing?'POST':'GET',headers:{Authorization:`Bearer ${grant.ticket}`,
        Accept:writing?'application/json':'application/octet-stream',...(writing?{'Content-Type':'application/octet-stream','Content-Length':args.bytes.length}:{})}},res=>{
        const parts=[];let size=0;
        res.on('data',bytes=>{size+=bytes.length;if(size>CHUNK+65536){res.destroy();finish(Error('Campus file response exceeds the bound'));}else parts.push(bytes);});
        res.on('aborted',()=>finish(Error('Campus file response interrupted; keep the original operation identity')));
        res.on('error',()=>finish(Error('Campus file response failed; partial and original identity were preserved')));
        res.on('end',()=>{
          if(res.statusCode!==200)return finish(Object.assign(Error(`Campus file request rejected (HTTP ${res.statusCode}); no VPS or Tail fallback`),{status:res.statusCode}));
          try{
            const bytes=Buffer.concat(parts);
            if(writing){
              if(!/^application\/json(?:;|$)/i.test(res.headers['content-type']||''))throw Error();
              const result=JSON.parse(bytes.toString());if(result.ok!==true||!result.result)throw Error();return finish(null,result.result);
            }
            if(res.headers['content-type']!=='application/octet-stream'||typeof res.headers['x-gpuq-file-metadata']!=='string'
              ||res.headers['x-gpuq-file-metadata'].length>4096||bytes.length>CHUNK)throw Error();
            const metadata=JSON.parse(Buffer.from(res.headers['x-gpuq-file-metadata'],'base64url').toString());
            if(metadata.fingerprint!==grant.file.fingerprint||metadata.size!==grant.file.size||metadata.path!==grant.file.path
              ||metadata.offset!==args.offset||metadata.protocol!==2||Object.hasOwn(metadata,'data'))throw Error();
            finish(null,{...metadata,data:bytes.toString('base64')});
          }catch{finish(Error('Campus node returned an invalid fixed-file receipt; partial preserved'));}
        });
      });
      req.on('error',()=>finish(Error('Campus file connection failed; no file bytes were redirected through VPS or Tail')));
      timer=setTimeout(()=>finish(Error('Campus file request timed out; keep the original operation identity')),timeoutMs);timer.unref?.();
      req.end(writing?args.bytes:undefined);
    }catch{finish(Error('Campus file request could not start; no fallback'));
    }
  });
}

export async function createPersonalFileTransport(call,{machine,context,path,action,identity={},agentFactory=pinnedUploadAgent,send=personalFileRequest,now=()=>Date.now()/1000}){
  const request={machine,...context,path,action,...identity};
  let grant=personalFileGrant((await call('files.direct-ticket',request)).result,path,action,now()),closed=false;
  const fixed={endpoint:grant.endpoint,pin:grant.certificateSha256,revision:grant.revision,machine:grant.machine,fingerprint:grant.file?.fingerprint};
  if(grant.machine!==machine)fail('Campus file node identity changed');
  if(action==='get')request.fingerprint=grant.file.fingerprint;
  const agent=agentFactory(grant.certificateSha256);
  return {
    async request(args){
      if(closed)fail('Campus file transport is closed');
      if(grant.expiresAt<=now()+10){
        const next=personalFileGrant((await call('files.direct-ticket',request)).result,path,action,now());
        if(next.endpoint!==fixed.endpoint||next.certificateSha256!==fixed.pin||next.revision!==fixed.revision||next.machine!==fixed.machine
          ||action==='get'&&next.file.fingerprint!==fixed.fingerprint)fail('Campus file route, policy or source changed; original operation paused');
        grant=next;
      }
      return send(grant,agent,action,args);
    },
    close(){closed=true;agent.destroy();}
  };
}

export async function downloadCampusFile(call,options){
  if(!options.context?.project)fail('Campus pull requires a selected personal project; legacy VPS file relay is unavailable');
  let transport;
  try{
    return await downloadFile(async(operation,args)=>{
      if(operation!=='files.get')fail('Invalid campus download operation');
      transport??=await createPersonalFileTransport(call,{machine:options.machine,context:options.context,path:options.path,
        action:'get',identity:args.fingerprint?{fingerprint:args.fingerprint}:{}});
      return {result:await transport.request({offset:args.offset})};
    },options);
  }finally{transport?.close();}
}
