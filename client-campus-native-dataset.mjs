import {approvedCampusEndpoints,chooseCampusEndpoint,probeCampusEndpoint,sameCampusEndpoints,campusConnectionFailure} from './client-campus-endpoints.mjs';
import {validateDirectGrant} from './client-direct-upload.mjs';
import {assertUploadRouteGrant} from './dist/upload-routes.js';
import {createCampusNativeAgent} from './client-campus-native.mjs';
import {validCampusTicketTime} from './dist/campus-ticket-time.js';

const CHUNK=1024**2,MAX_FILE_CHUNK=16*CHUNK,HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fileChunkBytes=grant=>grant.maxChunkBytes===MAX_FILE_CHUNK?MAX_FILE_CHUNK:CHUNK;
const fail=code=>{throw Object.assign(Error(`Campus native dataset transport stopped (${code}); preserve the original upload UUID`),{code});};
const safePath=path=>typeof path==='string'&&path.length>0&&Buffer.byteLength(path)<=4096&&!path.startsWith('/')&&!/[\\\x00-\x1f\x7f]/.test(path)&&path.split('/').every(part=>part&&!['.','..'].includes(part));
function nativeGrant(value,route,now){
  const grant=assertUploadRouteGrant(validateDirectGrant(value,now),route);
  if(grant.kind!=='campus-direct'||grant.routeId!=='primary'||!HASH.test(grant.revision||'')||typeof grant.machine!=='string'||!grant.machine||!validCampusTicketTime(grant,now))fail('INVALID_CAMPUS_GRANT');
  return grant;
}
export async function campusNativeDatasetRequest(grant,agent,{uploadId,action,path,offset,bytes,dialEndpoint}){
  if(!UUID.test(uploadId||'')||!['status','manifest','chunk'].includes(action)||agent?.pin!==grant.certificateSha256)fail('INVALID_REQUEST');
  const writing=action!=='status';
  if(action==='manifest'?path!==undefined:!safePath(path))fail('INVALID_PATH');
  if(writing&&(!Number.isSafeInteger(offset)||offset<0||!Buffer.isBuffer(bytes)||bytes.length>(action==='chunk'?fileChunkBytes(grant):CHUNK)))fail('INVALID_CHUNK');
  if(!writing&&(bytes!==undefined||offset!==undefined))fail('INVALID_REQUEST');
  // Only file chunks use the issued maximum; manifests keep the legacy bound.
  // Ticket claims, UUID, offset, manifest digest and node ACL stay unchanged.
  // Portal admission/display metadata is not part of the strict native schema.
  // Preserve every declared grant field and the opaque signed ticket verbatim.
  const fields=['available','protocol','kind','routeId','endpoint','certificateSha256','revision','machine',
    'grantId','ticket','expiresAt','issuedAt','ttl','chunkBytes','maxChunkBytes','file'];
  const wire=Object.fromEntries(fields.filter(key=>grant[key]!==undefined).map(key=>[key,grant[key]]));
  const {value,raw}=await agent.request({op:action,grant:wire,uploadId,...(dialEndpoint?{dialEndpoint}:{}),...(path!==undefined?{path}:{}),offset:writing?offset:0},writing?bytes:Buffer.alloc(0));
  if(raw.length||!value.result||typeof value.result!=='object'||Array.isArray(value.result))fail('INVALID_RECEIPT');
  return value.result;
}
export async function createCampusNativeDatasetTransport(requestGrant,{uploadId,route,agentFactory=createCampusNativeAgent,send=campusNativeDatasetRequest,probe=probeCampusEndpoint,observe,now=()=>Date.now()/1000}={}){
  if(!UUID.test(uploadId||'')||route&&(route.kind!=='campus-direct'||route.id!=='primary'))fail('INVALID_CAMPUS_ROUTE');
  let grant=nativeGrant(await requestGrant(),route,now()),closed=false;
  const endpoints=approvedCampusEndpoints(grant,grant.routes??route?.routes);
  if(route?.routes)sameCampusEndpoints(approvedCampusEndpoints(grant,route.routes),endpoints);
  if(route?.dialEndpoint&&!endpoints.some(e=>e.endpoint===route.dialEndpoint))throw Error('Probed campus endpoint changed before authorization');
  const fixed={endpoint:grant.endpoint,pin:grant.certificateSha256,revision:grant.revision,machine:grant.machine,chunkBytes:fileChunkBytes(grant)};
  let selected=endpoints.find(e=>e.endpoint===route?.dialEndpoint)??endpoints.find(e=>e.id==='primary');
  if(!route?.dialEndpoint&&endpoints.length>1)selected=await chooseCampusEndpoint(grant,endpoints,{probe});
  let agent=agentFactory(grant.certificateSha256),files=new Map();
  const dispatch=(action,args)=>send(grant,agent,{uploadId,action,...args,...(selected.endpoint!==grant.endpoint?{dialEndpoint:selected.endpoint}:{})});
  return {kind:'campus-direct',chunkBytes:fixed.chunkBytes,
    async request(action,args={}){
      if(closed)fail('CLOSED');
      if(grant.expiresAt<=now()+10){
        const next=nativeGrant(await requestGrant(),route,now());
        if(next.endpoint!==fixed.endpoint||next.certificateSha256!==fixed.pin||next.revision!==fixed.revision||next.machine!==fixed.machine||fileChunkBytes(next)!==fixed.chunkBytes)fail('GRANT_IDENTITY_CHANGED');
        sameCampusEndpoints(endpoints,approvedCampusEndpoints(next,next.routes??route?.routes));grant=next;
      }
      let result;
      try{result=await dispatch(action,args);}
      catch(error){
        if(endpoints.length!==2||!campusConnectionFailure(error))throw error;
        await agent.destroy();selected=await chooseCampusEndpoint(grant,endpoints,{probe,exclude:selected.endpoint,retryExcluded:true});agent=agentFactory(fixed.pin);
        if(action==='status')result=await dispatch(action,args);
        else {
          let offset,receipt;
          if(action==='manifest'){
            if(typeof observe!=='function')throw error;
            receipt=await observe();
            if(receipt?.uploadId!==uploadId||!['RECEIVING_MANIFEST','SEALING','UPLOADING'].includes(receipt.state))fail('MANIFEST_IDENTITY_CHANGED');
            offset=receipt.manifestOffset;
          }else{
            const expected=files.get(args.path);receipt=await dispatch('status',{path:args.path});const file=receipt?.file;
            if(!expected||!file||['path','size','sha256'].some(k=>file[k]!==expected[k]))fail('FILE_IDENTITY_CHANGED');offset=file.offset;
          }
          if(!Number.isSafeInteger(offset))fail('OFFSET_UNCONFIRMED');
          if(offset===args.offset+args.bytes.length&&(args.bytes.length>0||receipt.file?.complete===true))result={offset,...(receipt.file?.complete===true?{complete:true}:{})};
          else if(offset===args.offset)result=await dispatch(action,args);
          else fail('OFFSET_UNCONFIRMED');
        }
      }
      if(action==='status'&&result?.file)files.set(args.path,{...result.file});return result;
    },async close(){closed=true;await agent.destroy();}
  };
}
export async function probeCampusNativeUploadRoute(route,options={}){
  if(route?.kind!=='campus-direct'||route.id!=='primary'||!HASH.test(route.certificateSha256||''))fail('INVALID_CAMPUS_ROUTE');
  const agent=createCampusNativeAgent(route.certificateSha256,{...options,...(route.probeTimeoutMs?{timeoutMs:route.probeTimeoutMs+100}:{})});
  try{
    const {value,raw}=await agent.request({op:'probe',endpoint:route.endpoint,certificateSha256:route.certificateSha256,...(route.dialEndpoint&&route.dialEndpoint!==route.endpoint?{dialEndpoint:route.dialEndpoint}:{}),...(route.probeTimeoutMs?{probeTimeoutMs:route.probeTimeoutMs}:{}),offset:0});
    if(raw.length||!value.result||typeof value.result!=='object')fail('INVALID_PROBE');return value.result;
  }finally{await agent.destroy();}
}
