// Browser-trusted HTTPS only. File bodies never enter the Portal control API.
import {SHA256} from './dataset-upload.js';
export const PERSONAL_FILE_CHUNK_BYTES=1024**2,LARGE_PERSONAL_FILE_BYTES=100*1024**2;
const PROTOCOL='personal-file-campus-v1',HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=message=>{throw Object.assign(Error(message),{code:'CAMPUS_FILE_REQUIRED'});};
export function personalFileGrant(value,{machine,path,action},now=Date.now()/1000){
  if(!value||value.available!==true||value.protocol!==PROTOCOL||value.machine!==machine||value.kind!=='campus-direct'||value.routeId!=='primary'
    ||!UUID.test(value.grantId||'')||!HASH.test(value.certificateSha256||'')||!HASH.test(value.revision||'')||value.chunkBytes!==PERSONAL_FILE_CHUNK_BYTES
    ||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+301||typeof value.ticket!=='string'||! /^[A-Za-z0-9_.-]{20,4096}$/.test(value.ticket))
    fail('节点未确认校园文件通道；原文件操作已保留，不转 VPS 或 Tail。');
  let url;try{url=new URL(value.endpoint);}catch{fail('校园文件入口未确认。');}
  if(url.protocol!=='https:'||url.origin!==value.endpoint||url.pathname!=='/'||url.username||url.password||url.search||url.hash)fail('校园文件入口须为固定 HTTPS origin。');
  if(action==='get'&&(!value.file||value.file.protocol!==2||value.file.path!==path||!HASH.test(value.file.fingerprint||'')||!Number.isSafeInteger(value.file.size)||value.file.size<0))
    fail('原下载来源身份未确认，保留已下载片段。');
  return value;
}
async function boundedBody(response,maximum){
  const reader=response.body?.getReader();if(!reader)fail('校园文件回包不完整。');
  const parts=[];let length=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>maximum)fail('校园文件回包超过分块边界。');parts.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
export async function createPersonalFileTransport(call,{machine,context,path,action,identity={},signal,current=()=>true,fetcher=fetch,now=()=>Date.now()/1000}){
  const check=()=>{signal?.throwIfAborted();if(!current())throw new DOMException('账号或文件上下文已改变，原操作已暂停。','AbortError');};
  if(!context?.project||!['put','get'].includes(action)||action==='put'&&context.area!=='code')fail('校园文件传输须选择个人项目；任务输出只读。');
  const request={machine,...context,path,action,...identity};check();
  let grant=personalFileGrant(await call('files.direct-ticket',request,{signal}),{machine,path,action},now());check();
  const fixed={endpoint:grant.endpoint,pin:grant.certificateSha256,revision:grant.revision,fingerprint:grant.file?.fingerprint,size:grant.file?.size};
  if(action==='get')request.fingerprint=grant.file.fingerprint;
  let closed=false,inflight;
  return {
    file:grant.file,
    async request({offset,final,bytes}){
      check();if(closed)fail('校园文件连接已停止。');
      if(!Number.isSafeInteger(offset)||offset<0||action==='get'&&offset>fixed.size||action==='put'&&(typeof final!=='boolean'||!(bytes instanceof Uint8Array)||bytes.length>PERSONAL_FILE_CHUNK_BYTES))fail('校园文件分块身份无效。');
      if(grant.expiresAt<=now()+10){
        const next=personalFileGrant(await call('files.direct-ticket',request,{signal}),{machine,path,action},now());check();
        if(next.endpoint!==fixed.endpoint||next.certificateSha256!==fixed.pin||next.revision!==fixed.revision||action==='get'&&(next.file.fingerprint!==fixed.fingerprint||next.file.size!==fixed.size))
          fail('校园入口、配置或来源已改变；原操作暂停，未换路线。');
        grant=next;
      }
      const url=new URL(`/v1/files/${grant.grantId}/${action}`,grant.endpoint);url.searchParams.set('offset',String(offset));if(action==='put')url.searchParams.set('final',String(final));
      const controller=new AbortController(),abort=()=>controller.abort(signal.reason);inflight=controller;signal?.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(()=>controller.abort(Object.assign(Error('校园文件请求超时；请查询原上传编号。'),{code:'REQUEST_TIMEOUT'})),30000);
      try{
        check();const response=await fetcher(url,{method:action==='put'?'POST':'GET',headers:{Authorization:'Bearer '+grant.ticket,Accept:action==='put'?'application/json':'application/octet-stream',...(action==='put'?{'Content-Type':'application/octet-stream'}:{})},
          ...(action==='put'?{body:bytes}:{}),mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});check();
        if(response.status!==200){await response.body?.cancel().catch(()=>{});throw Object.assign(Error(`校园文件请求拒绝（HTTP ${response.status}）；原操作保留，未中转。`),{status:response.status});}
        if(action==='put'){
          if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))fail('校园上传回执格式未确认。');
          const raw=await boundedBody(response,65536);check();let value;try{value=JSON.parse(new TextDecoder().decode(raw));}catch{fail('校园上传回执不完整。');}
          if(value?.ok!==true||!value.result)fail('校园上传回执未确认。');return value.result;
        }
        const header=response.headers.get('x-gpuq-file-metadata');let metadata;
        try{if(!header||header.length>4096||! /^[A-Za-z0-9_-]+$/.test(header))throw Error();metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(header.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0))));}catch{fail('原下载来源回执未确认。');}
        if(response.headers.get('content-type')!=='application/octet-stream'||metadata.protocol!==2||metadata.path!==path||metadata.fingerprint!==fixed.fingerprint||metadata.size!==fixed.size||metadata.offset!==offset||typeof metadata.eof!=='boolean'||Object.keys(metadata).some(key=>!['protocol','path','size','offset','eof','fingerprint'].includes(key)))fail('原下载来源、指纹或偏移已改变。');
        const body=await boundedBody(response,PERSONAL_FILE_CHUNK_BYTES);check();
        if(body.length!==Math.min(PERSONAL_FILE_CHUNK_BYTES,fixed.size-offset)||metadata.eof!==(offset+body.length===fixed.size))fail('下载分块不完整；保留已确认的片段。');
        return {...metadata,bytes:body};
      }catch(error){check();if(controller.signal.aborted)throw controller.signal.reason;throw error;}
      finally{clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);if(inflight===controller)inflight=null;}
    },
    close(){closed=true;inflight?.abort();}
  };
}
const digestCopy=hash=>Object.assign(Object.create(SHA256.prototype),{...hash,h:hash.h.slice(),buffer:hash.buffer.slice(),words:hash.words.slice()}).hex();
export async function downloadPersonalFile(call,{machine,context,path,actor,state={},write,signal,current=()=>true,onProgress=()=>{},onWarning=()=>{},transportFactory=createPersonalFileTransport}){
  const check=()=>{signal?.throwIfAborted();if(!current())throw new DOMException('账号或文件上下文已改变，下载已暂停。','AbortError');};
  const identity=JSON.stringify([actor,machine,context,path]);check();
  if(state.identity!==undefined&&state.identity!==identity)fail('下载不属于原账号或文件上下文，未采用旧片段。');
  let transport;
  try{
    transport=await transportFactory(call,{machine,context,path,action:'get',identity:state.fingerprint?{fingerprint:state.fingerprint}:{},signal,current});check();
    const file=transport.file;
    if(state.fingerprint&&state.fingerprint!==file.fingerprint||state.size!==undefined&&state.size!==file.size)fail('原下载来源已改变，未覆盖已有片段。');
    state.identity=identity;state.fingerprint=file.fingerprint;state.size=file.size;state.offset??=0;state.hash??=new SHA256();
    if(!Number.isSafeInteger(state.offset)||state.offset<0||state.offset>state.size||!(state.hash instanceof SHA256)||state.hash.bytes!==state.offset||state.offset>0&&state.prefixSha256!==digestCopy(state.hash))fail('原下载偏移或已确认前缀未确认。');
    if(state.size>LARGE_PERSONAL_FILE_BYTES)onWarning(state.size);
    do{
      check();const result=await transport.request({offset:state.offset});check();const offset=state.offset;
      await write(result.bytes,offset);check();state.hash.update(result.bytes);state.offset+=result.bytes.length;state.prefixSha256=digestCopy(state.hash);onProgress({bytes:state.offset,totalBytes:state.size});
      if(result.eof)return {path,bytes:state.offset,fingerprint:state.fingerprint,sha256:state.prefixSha256};
    }while(true);
  }finally{transport?.close();}
}
