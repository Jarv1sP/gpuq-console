import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,open,chmod,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {constants as fsConstants} from 'node:fs';

const MAX=1024**2,HEADER=65536,HASH=/^[a-f0-9]{64}$/;
// The separate native builder supplies this esbuild define. No network fetch,
// installed Go/curl dependency, privilege request or platform fallback exists.
const EMBEDDED=typeof STARGATE_CAMPUS_NATIVE_BUNDLE==='undefined'?null:STARGATE_CAMPUS_NATIVE_BUNDLE;
const failed=(code,status,writeMayHaveReachedPeer=false)=>Object.assign(Error(`Campus physical transport stopped (${code}); keep the original operation identity; no VPS or Tail fallback`),{code,status,writeMayHaveReachedPeer});
const writing=op=>['put','manifest','chunk'].includes(op);
export async function extractCampusNative(artifacts=EMBEDDED,{platform=process.platform,arch=process.arch}={}){
  if(platform!=='linux'||!['x64','arm64'].includes(arch))throw failed('PLATFORM_UNSUPPORTED');
  if(artifacts==null&&arguments[0]===undefined){
    // Source CLI uses the same verified output as npm run build:client.
    // npm run cli runs that build first; an installed one-file client embeds it.
    const path=new URL('./build/campus-native/embedded-artifacts.private.json',import.meta.url);
    let fd;
    try{fd=await open(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);const info=await fd.stat();
      if(!info.isFile()||info.nlink!==1||info.size>64*1024**2||(info.mode&0o022)||process.getuid&&![0,process.getuid()].includes(info.uid))throw Error();
      artifacts=JSON.parse(await fd.readFile('utf8'));
    }catch{throw failed('SOURCE_NATIVE_BUILD_REQUIRED');}finally{await fd?.close();}
  }
  const item=artifacts?.schema===1&&artifacts.protocol==='campus-native-https-v1'?artifacts.artifacts?.[`${platform}-${arch}`]:null;
  if(!item||!HASH.test(item.sha256||'')||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>20*1024**2||typeof item.base64!=='string')throw failed('NATIVE_NOT_BUNDLED');
  if(item.base64.length>28*1024**2)throw failed('NATIVE_ARTIFACT_INVALID');
  const bytes=Buffer.from(item.base64,'base64');
  if(bytes.length!==item.bytes||bytes.toString('base64')!==item.base64||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw failed('NATIVE_ARTIFACT_INVALID');
  const folder=await mkdtemp(join(tmpdir(),'stargate-campus-'));await chmod(folder,0o700);const path=join(folder,'campus-http');
  try{
    const fd=await open(path,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
    await chmod(path,0o700);const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o7777)!==0o700||process.getuid&&info.uid!==process.getuid())throw failed('NATIVE_ARTIFACT_INVALID');
    return {path,cleanup:()=>rm(folder,{recursive:true,force:true})};
  }catch(error){await rm(folder,{recursive:true,force:true});throw error;}
}

const bounded=(promise,timeoutMs,code)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(failed(code)),timeoutMs);
  Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});
export function createCampusNativeAgent(pin,{artifacts=EMBEDDED??undefined,spawnProcess=spawn,extract=extractCampusNative,timeoutMs=35000,shutdownTimeoutMs=2000}={}){
  if(!HASH.test(pin||''))throw failed('INVALID_PIN');
  if(!Number.isSafeInteger(shutdownTimeoutMs)||shutdownTimeoutMs<10||shutdownTimeoutMs>5000)throw failed('INVALID_SHUTDOWN_BOUND');
  let child,binary,starting,closed=false,stopped=false,seq=0,pending,buffer=Buffer.alloc(0),queue=Promise.resolve(),cleanup,exitDone=Promise.resolve(),closing,killTimer,killStarted=false;
  const cleanupOwn=()=>cleanup??=Promise.resolve().then(()=>binary?.cleanup());
  const stop=error=>{
    stopped=true;if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}
    if(child&&!killStarted){killStarted=true;child.stdin.destroy();child.kill('SIGTERM');
      killTimer=setTimeout(()=>child.kill('SIGKILL'),Math.floor(shutdownTimeoutMs/2));killTimer.unref?.();}
  };
  const start=()=>starting??=(async()=>{
    binary=await extract(artifacts);if(closed){await cleanupOwn();throw failed('CLOSED');}
    // Ticket/body never enter argv, environment, stderr, telemetry or files.
    child=spawnProcess(binary.path,[],{stdio:['pipe','pipe','pipe'],env:{}});
    exitDone=new Promise(resolve=>child.once('close',()=>{clearTimeout(killTimer);cleanupOwn().catch(()=>{});resolve();}));
    child.stdin.on('error',()=>stop(failed('ACK_UNCONFIRMED',undefined,writing(pending?.op))));
    child.stdout.on('error',()=>stop(failed('NATIVE_FRAME_INVALID')));
    child.stderr.on('data',()=>stop(failed('NATIVE_DIAGNOSTIC_REJECTED')));
    child.on('error',()=>stop(failed('NATIVE_START_FAILED')));
    child.on('exit',()=>{if(!closed)stop(failed('NATIVE_EXITED',undefined,writing(pending?.op)));});
    child.stdout.on('data',part=>{
      if(stopped)return;
      if(!pending||buffer.length+part.length>MAX+HEADER+4)return stop(failed('NATIVE_FRAME_INVALID'));
      buffer=Buffer.concat([buffer,part]);if(buffer.length<4)return;const n=buffer.readUInt32BE(0);
      if(n<1||n>HEADER)return stop(failed('NATIVE_FRAME_INVALID'));if(buffer.length<4+n)return;
      let value;try{value=JSON.parse(buffer.subarray(4,4+n).toString());}catch{return stop(failed('NATIVE_FRAME_INVALID'));}
      if(value.schema!==1||value.seq!==pending.seq||typeof value.ok!=='boolean'||!Number.isSafeInteger(value.bodyBytes)||value.bodyBytes<0||value.bodyBytes>MAX)return stop(failed('NATIVE_FRAME_INVALID'));
      const end=4+n+value.bodyBytes;if(buffer.length<end)return;if(buffer.length!==end)return stop(failed('NATIVE_FRAME_INVALID'));
      const raw=buffer.subarray(4+n,end),entry=pending;buffer=Buffer.alloc(0);pending=null;clearTimeout(entry.timer);
      if(!value.ok){entry.reject(failed(typeof value.code==='string'&&/^[A-Z_]{1,64}$/.test(value.code)?value.code:'NATIVE_REJECTED',value.status,value.writeMayHaveReachedPeer===true));stop(failed('SESSION_STOPPED'));return;}
      entry.resolve({value,raw});
    });
  })();
  const request=(header,bytes=Buffer.alloc(0))=>{
    const work=queue.then(async()=>{
      if(closed||stopped)throw failed('SESSION_STOPPED');await start();if(closed||stopped)throw failed('SESSION_STOPPED');
      if(!Buffer.isBuffer(bytes)||bytes.length>MAX)throw failed('INVALID_CHUNK');const id=++seq;
      const meta=Buffer.from(JSON.stringify({...header,schema:1,seq:id,bodyBytes:bytes.length}));if(meta.length>16384)throw failed('INVALID_FRAME');
      const size=Buffer.alloc(4);size.writeUInt32BE(meta.length);
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>stop(failed('ACK_UNCONFIRMED',undefined,writing(header.op))),timeoutMs);timer.unref?.();pending={seq:id,op:header.op,resolve,reject,timer};
        // Exactly one write; failures are reconciled by the existing journal.
        child.stdin.write(Buffer.concat([size,meta,bytes]),error=>{if(error)stop(failed('ACK_UNCONFIRMED',undefined,writing(header.op)));});
      });
    });queue=work.catch(()=>{});return work;
  };
  return {pin,request,destroy(){return closing??=(async()=>{
    closed=true;stop(failed('CLOSED'));
    if(starting)await bounded(starting.catch(()=>{}),shutdownTimeoutMs,'NATIVE_START_EXIT_UNCONFIRMED');
    if(binary&&!child)cleanupOwn();
    await bounded(exitDone,shutdownTimeoutMs,'NATIVE_EXIT_UNCONFIRMED');
    if(cleanup)await bounded(cleanup,shutdownTimeoutMs,'NATIVE_CLEANUP_UNCONFIRMED');
  })();}};
}

// Signature matches personalFileRequest; use this together with the factory
// above in createPersonalFileTransport. Existing UUID/fingerprint/ACK recovery
// stays in that caller. Closing the transport destroys its one native process.
export async function campusNativePersonalFileRequest(grant,agent,action,args){
  if(!agent||agent.pin!==grant?.certificateSha256||!['get','put'].includes(action)||!Number.isSafeInteger(args?.offset)||args.offset<0)throw failed('INVALID_REQUEST');
  if(action==='put'&&(typeof args.final!=='boolean'||!Buffer.isBuffer(args.bytes)||args.bytes.length>MAX))throw failed('INVALID_CHUNK');
  const fields=['available','protocol','kind','routeId','endpoint','certificateSha256','revision','machine','grantId','ticket','expiresAt','chunkBytes'];
  const wire=Object.fromEntries(fields.map(key=>[key,grant[key]]));
  // Upload status carries receipt/state fields; they are not TLS identity.
  // The original caller and opaque issued ticket retain its upload UUID/SHA.
  wire.file=action==='get'?Object.fromEntries(['protocol','path','size','fingerprint'].map(key=>[key,grant.file?.[key]])):{path:grant.file?.path||''};
  const {value,raw}=await agent.request({op:action,grant:wire,offset:args.offset,...(action==='put'?{final:args.final}:{})},action==='put'?args.bytes:Buffer.alloc(0));
  if(action==='put'){if(raw.length||!value.result||typeof value.result!=='object')throw failed('NATIVE_RECEIPT_INVALID');return value.result;}
  const m=value.metadata;
  if(!m||Object.hasOwn(m,'data')||m.protocol!==2||m.path!==grant.file?.path||m.fingerprint!==grant.file?.fingerprint||m.size!==grant.file?.size||m.offset!==args.offset||typeof m.eof!=='boolean'||raw.length>MAX||m.offset+raw.length>m.size||m.eof!==(m.offset+raw.length===m.size))throw failed('NATIVE_RECEIPT_INVALID');
  return {...m,data:raw.toString('base64')};
}
export function campusNativeTransportOptions(options={}){
  return {agentFactory:pin=>createCampusNativeAgent(pin,options),send:campusNativePersonalFileRequest};
}
