import {validateDirectGrant} from './client-direct-upload.mjs';
import {assertUploadRouteGrant} from './dist/upload-routes.js';
import {createCampusNativeAgent} from './client-campus-native.mjs';

const CHUNK=1024**2,HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=code=>{throw Object.assign(Error(`Campus native dataset transport stopped (${code}); preserve the original upload UUID`),{code});};
const safePath=path=>typeof path==='string'&&path.length>0&&Buffer.byteLength(path)<=4096&&!path.startsWith('/')&&!/[\\\x00-\x1f\x7f]/.test(path)&&path.split('/').every(part=>part&&!['.','..'].includes(part));
function nativeGrant(value,route,now){
  const grant=assertUploadRouteGrant(validateDirectGrant(value,now),route);
  if(grant.kind!=='campus-direct'||grant.routeId!=='primary'||!HASH.test(grant.revision||'')||typeof grant.machine!=='string'||!grant.machine||grant.expiresAt>now+301)fail('INVALID_CAMPUS_GRANT');
  return grant;
}
export async function campusNativeDatasetRequest(grant,agent,{uploadId,action,path,offset,bytes}){
  if(!UUID.test(uploadId||'')||!['status','manifest','chunk'].includes(action)||agent?.pin!==grant.certificateSha256)fail('INVALID_REQUEST');
  const writing=action!=='status';
  if(action==='manifest'?path!==undefined:!safePath(path))fail('INVALID_PATH');
  if(writing&&(!Number.isSafeInteger(offset)||offset<0||!Buffer.isBuffer(bytes)||bytes.length>CHUNK))fail('INVALID_CHUNK');
  if(!writing&&(bytes!==undefined||offset!==undefined))fail('INVALID_REQUEST');
  // Keep the issued 16 MiB maximum intact. We choose legal 1 MiB blocks;
  // ticket claims, UUID, offset, manifest digest and node ACL remain unchanged.
  const {value,raw}=await agent.request({op:action,grant,uploadId,...(path!==undefined?{path}:{}),offset:writing?offset:0},writing?bytes:Buffer.alloc(0));
  if(raw.length||!value.result||typeof value.result!=='object'||Array.isArray(value.result))fail('INVALID_RECEIPT');
  return value.result;
}
export async function createCampusNativeDatasetTransport(requestGrant,{uploadId,route,agentFactory=createCampusNativeAgent,send=campusNativeDatasetRequest,now=()=>Date.now()/1000}={}){
  if(!UUID.test(uploadId||'')||route&&(route.kind!=='campus-direct'||route.id!=='primary'))fail('INVALID_CAMPUS_ROUTE');
  let grant=nativeGrant(await requestGrant(),route,now()),closed=false;
  const fixed={endpoint:grant.endpoint,pin:grant.certificateSha256,revision:grant.revision,machine:grant.machine};
  const agent=agentFactory(grant.certificateSha256);
  return {kind:'campus-direct',chunkBytes:CHUNK,
    async request(action,args={}){
      if(closed)fail('CLOSED');
      if(grant.expiresAt<=now()+10){
        const next=nativeGrant(await requestGrant(),route,now());
        if(next.endpoint!==fixed.endpoint||next.certificateSha256!==fixed.pin||next.revision!==fixed.revision||next.machine!==fixed.machine)fail('GRANT_IDENTITY_CHANGED');
        grant=next;
      }
      return send(grant,agent,{uploadId,action,...args});
    },async close(){closed=true;await agent.destroy();}
  };
}
export async function probeCampusNativeUploadRoute(route,options={}){
  if(route?.kind!=='campus-direct'||route.id!=='primary'||!HASH.test(route.certificateSha256||''))fail('INVALID_CAMPUS_ROUTE');
  const agent=createCampusNativeAgent(route.certificateSha256,options);
  try{
    const {value,raw}=await agent.request({op:'probe',endpoint:route.endpoint,certificateSha256:route.certificateSha256,offset:0});
    if(raw.length||!value.result||typeof value.result!=='object')fail('INVALID_PROBE');return value.result;
  }finally{await agent.destroy();}
}
