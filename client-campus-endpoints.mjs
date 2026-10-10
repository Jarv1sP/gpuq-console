// Endpoints come only from an authenticated Portal/node descriptor. The grant,
// canonical TLS name, pin, revision and operation identity never change.
import {isIP} from 'node:net';
import {createCampusNativeAgent} from './client-campus-native.mjs';
const fail=()=>{throw Error('Approved campus endpoints changed or are invalid; original operation preserved');};
export function privateLanOrigin(value){
  let u;try{u=new URL(value);}catch{return false;}
  if(u.protocol!=='https:'||u.origin!==value||u.username||u.password||u.search||u.hash||u.pathname!=='/'||isIP(u.hostname)!==4)return false;
  const [a,b]=u.hostname.split('.').map(Number);
  return a===10||a===172&&b>=16&&b<=31||a===192&&b===168;
}
export function approvedCampusEndpoints(grant,routes=grant.routes){
  if(routes===undefined)return [{id:'primary',kind:'campus-direct',endpoint:grant.endpoint}];
  if(!Array.isArray(routes)||routes.length<1||routes.length>2)fail();
  if(routes.some(r=>!r||Object.keys(r).sort().join(',')!=='endpoint,id,kind'||r.kind!=='campus-direct'))fail();
  const primary=routes.find(r=>r.id==='primary'),lan=routes.find(r=>r.id==='node-lan');
  if(primary?.endpoint!==grant.endpoint||routes.length!==1+Number(!!lan)||lan&&(!privateLanOrigin(lan.endpoint)||lan.endpoint===grant.endpoint))fail();
  return [lan,primary].filter(Boolean).map(r=>Object.freeze({...r}));
}
export const campusConnectionFailure=error=>['PHYSICAL_CONNECT_FAILED','ACK_UNCONFIRMED','RESPONSE_INTERRUPTED','SESSION_STOPPED','CONNECTION_FAILED','CONNECTION_REFUSED','NETWORK_UNREACHABLE','TIMEOUT','ETIMEDOUT','ECONNRESET','EPIPE','ECONNREFUSED'].includes(error?.code);
// Use only when the caller has already decided its result. A bounded helper
// shutdown failure cannot undo a verified receipt or replace the original
// business error. In-flight request/ACK cleanup remains strict in the agent.
export async function finishCampusOperation(close,{warn=code=>process.stderr.write(`Warning: campus helper shutdown was not confirmed (${code}); original operation result unchanged.\n`)}={}){
  try{await close();}
  catch(error){
    const code=['NATIVE_EXIT_UNCONFIRMED','NATIVE_START_EXIT_UNCONFIRMED','NATIVE_CLEANUP_UNCONFIRMED'].includes(error?.code)?error.code:'NATIVE_CLEANUP_UNCONFIRMED';
    try{warn(code);}catch{/* A closed warning sink must not change the result. */}
  }
}
const ENDPOINT_CODES=new Set(['PHYSICAL_CONNECT_FAILED','ACK_UNCONFIRMED','RESPONSE_INTERRUPTED','SESSION_STOPPED','CONNECTION_FAILED','CONNECTION_REFUSED','NETWORK_UNREACHABLE','TIMEOUT','ETIMEDOUT','ECONNRESET','EPIPE','ECONNREFUSED','TLS_CHAIN_OR_NAME','TLS_PIN_CHANGED','TLS_UNTRUSTED','HANDSHAKE_EOF','HANDSHAKE_TIMEOUT','HANDSHAKE_FAILED','NETWORK_CHANGED','HTTP_REJECTED','NATIVE_EXITED','NATIVE_START_FAILED','CAMPUS_CAPABILITIES_INVALID']);
const endpointFailure=error=>ENDPOINT_CODES.has(error?.code)?error.code:'PROBE_FAILED';
const invalidCapabilities=()=>Object.assign(Error('Approved campus endpoint capabilities differ'),{code:'CAMPUS_CAPABILITIES_INVALID'});
export async function probeCampusEndpoint(grant,endpoint,{nativeOptions={},agentFactory=createCampusNativeAgent}={}){
  const timeoutMs=endpoint.id==='node-lan'?1000:2500;
  const agent=agentFactory(grant.certificateSha256,{...nativeOptions,timeoutMs:timeoutMs+100});
  try{
    const {value,raw}=await agent.request({op:'probe',endpoint:grant.endpoint,certificateSha256:grant.certificateSha256,
      ...(endpoint.endpoint!==grant.endpoint?{dialEndpoint:endpoint.endpoint}:{}),probeTimeoutMs:timeoutMs,offset:0});
    const observed=value.result;
    if(raw.length||observed?.protocol!=='dataset-upload-v1'||observed.listenerReady!==true||observed.machine!==grant.machine||observed.revision!==grant.revision)throw invalidCapabilities();
    return observed;
  }finally{await finishCampusOperation(()=>agent.destroy());}
}
export async function chooseCampusEndpoint(grant,endpoints,{probe=probeCampusEndpoint,exclude,retryExcluded=false}={}){
  // A campus-only client may not reach the LAN alias. A closed connection
  // does not revoke its approved endpoint: try the other alias first, then
  // re-probe the original identity before constructing a fresh connection.
  const candidates=endpoints.filter(endpoint=>endpoint.endpoint!==exclude);
  if(retryExcluded)candidates.push(...endpoints.filter(endpoint=>endpoint.endpoint===exclude));
  const failures=new Map();
  for(const endpoint of candidates){
    const id=['primary','node-lan'].includes(endpoint.id)?endpoint.id:'endpoint';
    try{const observed=await probe(grant,endpoint);
      if(observed?.protocol!=='dataset-upload-v1'||observed.listenerReady!==true||observed.machine!==grant.machine||observed.revision!==grant.revision)throw invalidCapabilities();return endpoint;}
    catch(error){if(!failures.has(id))failures.set(id,endpointFailure(error));}
  }
  const endpointErrors=Array.from(failures,([id,code])=>({id,code}));
  throw Object.assign(Error(`No approved LAN or campus endpoint passed pinned TLS and capabilities (${endpointErrors.map(({id,code})=>`${id}: ${code}`).join('; ')}); original UUID and offsets preserved`),{code:'CAMPUS_ENDPOINT_UNAVAILABLE',endpointErrors});
}
export function sameCampusEndpoints(before,after){
  if(JSON.stringify(before)!==JSON.stringify(after))fail();
}
