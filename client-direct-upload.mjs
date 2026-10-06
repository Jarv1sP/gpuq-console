import {Agent,request as httpsRequest} from 'node:https';
import {connect as tlsConnect} from 'node:tls';
import {createHash,timingSafeEqual} from 'node:crypto';
import {assertUploadRouteGrant,uploadProbeFailureCode} from './dist/upload-routes.js';

export const RELAY_LIMIT_BYTES=256*1024*1024;
const PROTOCOL='dataset-upload-v1',CHUNK=1024*1024,MAX_FILE_CHUNK=16*1024*1024,RESPONSE_LIMIT=2*1024*1024;
const denied=message=>{throw Error(message);};
const probeError=(message,uploadProbeCode)=>Object.assign(Error(message),{uploadProbeCode});
const connectionCode=error=>{
  switch(error?.code){
    case 'ECONNREFUSED':return 'CONNECTION_REFUSED';
    case 'ENOTFOUND':case 'EAI_AGAIN':return 'DNS_FAILED';
    case 'ENETUNREACH':case 'EHOSTUNREACH':return 'NETWORK_UNREACHABLE';
    case 'ETIMEDOUT':return 'TIMEOUT';
    case 'ECONNRESET':case 'EPIPE':return 'CONNECTION_FAILED';
    default:return 'TLS_FAILED';
  }
};

export function validateDirectGrant(value,now=Date.now()/1000){
  if(!value||value.available!==true||value.protocol!==PROTOCOL)denied('Direct upload is not available');
  let endpoint;try{endpoint=new URL(value.endpoint);}catch{denied('Invalid direct upload endpoint');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/'||endpoint.origin!==value.endpoint)
    denied('Direct upload requires an HTTPS origin without credentials or redirects');
  if(!/^[a-f0-9]{64}$/.test(value.certificateSha256||'')||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+601||value.chunkBytes!==CHUNK||typeof value.ticket!=='string'||!/^[A-Za-z0-9_.-]{20,4096}$/.test(value.ticket))
    denied('Invalid or expired direct upload grant');
  if(value.maxChunkBytes!==undefined&&![CHUNK,MAX_FILE_CHUNK].includes(value.maxChunkBytes))denied('Invalid direct file chunk limit');
  return {...value,endpoint:endpoint.origin};
}

// A self-signed node certificate is trusted only by its portal-issued SHA256
// pin. The Agent receives the socket AFTER the pin check, so the HTTP request
// (including its bearer) cannot be written to an unverified TLS peer.
export function pinnedUploadAgent(certificateSha256,{connect=tlsConnect,timeoutMs=15000}={}){
  if(!/^[a-f0-9]{64}$/.test(certificateSha256||''))denied('Invalid upload certificate pin');
  const agent=new Agent({keepAlive:true,maxSockets:1,maxFreeSockets:1});
  agent.createConnection=(options,callback)=>{
    let socket,finished=false;
    const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);if(error){socket?.destroy();callback(error);}else callback(null,socket);};
    const timer=setTimeout(()=>finish(probeError('Direct upload TLS connection timed out','TIMEOUT')),timeoutMs);timer.unref?.();
    try{
      socket=connect({...options,rejectUnauthorized:false,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1']});
      socket.once('error',error=>finish(probeError('Direct upload TLS connection failed',connectionCode(error))));
      socket.once('secureConnect',()=>{
        try{
          const raw=socket.getPeerCertificate(true)?.raw;
          if(!raw||!timingSafeEqual(createHash('sha256').update(raw).digest(),Buffer.from(certificateSha256,'hex')))
            return finish(probeError('Direct upload certificate does not match the authorized node','CERTIFICATE_MISMATCH'));
          finish();
        }catch{finish(probeError('Direct upload certificate validation failed','TLS_FAILED'));}
      });
    }catch(error){finish(probeError('Direct upload TLS connection failed',connectionCode(error)));}
    // Deliberately do not return the unverified socket to Agent.
    return undefined;
  };
  return agent;
}

export function directUploadRequest(grant,agent,{uploadId,action,path,offset,bytes},{request=httpsRequest,timeoutMs=30000}={}){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uploadId||'')||!['status','manifest','chunk'].includes(action))denied('Invalid direct upload request');
  const target=new URL(`/v1/uploads/${uploadId}/${action}`,grant.endpoint);
  if(path!==undefined){if(typeof path!=='string'||Buffer.byteLength(path)>4096||/[\x00-\x1f\x7f]/.test(path))denied('Invalid upload file path');target.searchParams.set('path',path);}
  const writing=action!=='status';
  const chunkLimit=action==='chunk'?(grant.maxChunkBytes??CHUNK):CHUNK;
  if(writing){if(![CHUNK,MAX_FILE_CHUNK].includes(chunkLimit)||!Number.isSafeInteger(offset)||offset<0||!Buffer.isBuffer(bytes)||bytes.length>chunkLimit)denied('Invalid direct upload chunk');target.searchParams.set('offset',String(offset));}
  return new Promise((resolve,reject)=>{
    let req,timer,done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);if(error){req?.destroy();reject(error);}else resolve(result);};
    try{
      req=request(target,{agent,method:writing?'POST':'GET',headers:{Authorization:`Bearer ${grant.ticket}`,Accept:'application/json',...(writing?{'Content-Type':'application/octet-stream','Content-Length':bytes.length}:{})}},res=>{
        let size=0;const parts=[];
        res.on('data',part=>{size+=part.length;if(size>RESPONSE_LIMIT){res.destroy();finish(Error('Direct upload response exceeds the limit'));}else parts.push(part);});
        res.on('aborted',()=>finish(Error('Direct upload response was interrupted; repeat the same command to resume')));
        res.on('error',()=>finish(Error('Direct upload response failed; repeat the same command to resume')));
        res.on('end',()=>{
          if(done)return;
          // No redirect following, and no raw server body in error messages.
          if(res.statusCode!==200)return finish(Error(`Direct upload request rejected (HTTP ${res.statusCode}); repeat the same command to inspect and resume`));
          if(!/^application\/json(?:;|$)/i.test(res.headers['content-type']||''))return finish(Error('Direct upload returned an invalid response type'));
          try{const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(value.ok!==true||!value.result||typeof value.result!=='object')throw Error();finish(null,value.result);}catch{finish(Error('Direct upload returned an invalid receipt'));}
        });
      });
      req.on('error',error=>finish(Error(error.message?.startsWith('Direct upload ')?error.message:'Direct upload connection failed; no file bytes were redirected through the portal')));
      timer=setTimeout(()=>finish(Error('Direct upload timed out; repeat the same command to resume')),timeoutMs);timer.unref?.();
      req.end(writing?bytes:undefined);
    }catch{finish(Error('Direct upload request could not be started'));}
  });
}

export async function probeDirectUploadRoute(route,{request=httpsRequest,timeoutMs=2500,agentFactory=pinnedUploadAgent}={}){
  const agent=agentFactory(route.certificateSha256,{timeoutMs});
  try{return await new Promise((resolve,reject)=>{
    let req,timer,done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){req?.destroy();reject(error);}else resolve(value);};
    try{
      req=request(new URL('/capabilities',route.endpoint),{agent,method:'GET',headers:{Accept:'application/json'}},res=>{
        let size=0;const parts=[];
        res.on('data',part=>{size+=part.length;if(size>4096){finish(probeError('Upload probe exceeds response limit','RESPONSE_TOO_LARGE'));res.destroy();}else parts.push(part);});
        res.on('aborted',()=>finish(probeError('Upload probe interrupted','CONNECTION_FAILED')));res.on('error',()=>finish(probeError('Upload probe failed','CONNECTION_FAILED')));
        res.on('end',()=>{
          if(res.statusCode!==200)return finish(probeError('Upload probe rejected','HTTP_REJECTED'));
          if(!/^application\/json(?:;|$)/i.test(res.headers['content-type']||''))return finish(probeError('Upload probe rejected','INVALID_RESPONSE'));
          try{finish(null,JSON.parse(Buffer.concat(parts)));}catch{finish(probeError('Invalid upload probe','INVALID_RESPONSE'));}});
      });
      req.on('error',error=>finish(probeError('Upload probe connection failed',uploadProbeFailureCode(error))));
      timer=setTimeout(()=>finish(probeError('Upload probe timed out','TIMEOUT')),timeoutMs);timer.unref?.();req.end();
    }catch{finish(probeError('Upload probe could not start','PROBE_FAILED'));}
  });}finally{agent.destroy();}
}

export async function createDirectDatasetTransport(requestGrant,{uploadId,route,agentFactory=pinnedUploadAgent,send=directUploadRequest,now=()=>Date.now()/1000}={}){
  let grant=assertUploadRouteGrant(validateDirectGrant(await requestGrant(),now()),route),agent=agentFactory(grant.certificateSha256),closed=false;
  const endpoint=grant.endpoint,pin=grant.certificateSha256;
  return {
    kind:route?.kind||'campus-direct',
    get chunkBytes(){return grant.maxChunkBytes??CHUNK;},
    async request(action,args={}){
      if(closed)denied('Direct upload transport is closed');
      if(grant.expiresAt<=now()+10){
        const next=assertUploadRouteGrant(validateDirectGrant(await requestGrant(),now()),route);
        if(next.endpoint!==endpoint||next.certificateSha256!==pin)denied('Direct upload destination changed; repeat the command to re-authorize');
        grant=next;
      }
      return send(grant,agent,{uploadId,action,...args});
    },
    close(){closed=true;agent.destroy();}
  };
}
