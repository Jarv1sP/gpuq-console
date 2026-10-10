// Candidates originate only in authenticated node configuration. This module
// never accepts a user URL, changes an OS route, or issues an upload ticket.
const protocol='dataset-upload-v1',hex=/^[a-f0-9]{64}$/,id=/^[a-z][a-z0-9-]{0,31}$/;
// Only these bounded classifications may cross the probe/error boundary. Never
// echo native socket details, response bodies, endpoints or observed identities.
const probeFailures=Object.freeze({
  CONNECTION_REFUSED:'connection refused',DNS_FAILED:'DNS lookup failed',NETWORK_UNREACHABLE:'network unreachable',
  CONNECTION_FAILED:'connection failed',TIMEOUT:'timed out',TLS_FAILED:'TLS connection failed',CERTIFICATE_MISMATCH:'certificate pin mismatch',
  HTTP_REJECTED:'HTTP probe rejected',INVALID_RESPONSE:'invalid probe response',RESPONSE_TOO_LARGE:'probe response too large',
  PROTOCOL_MISMATCH:'protocol mismatch',LISTENER_NOT_READY:'listener not ready',NODE_MISMATCH:'node identity mismatch',
  REVISION_MISMATCH:'configuration revision mismatch',PROBE_FAILED:'probe failed'
});
export function uploadProbeFailureCode(error){
  const code=error?.uploadProbeCode;
  return typeof code==='string'&&Object.hasOwn(probeFailures,code)?code:'PROBE_FAILED';
}
const fail=()=>{throw Error('Approved upload routes are invalid or unavailable; no VPS fallback was attempted');};
export function uploadStorageMachine(value,requestedMachine,previous){
  // Old node replies remain valid. Placement-aware replies bind one physical
  // writer independently of the selected training machine for the whole run.
  if(value?.placementProtocol===undefined)return previous||requestedMachine;
  if(value.placementProtocol!==1||value.requestedMachine!==requestedMachine||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.storageMachine||'')||
    !['hdd','existing'].includes(value.storageTier)||typeof value.legacyPlacement!=='boolean'||
    value.legacyPlacement!==(value.storageTier==='existing')||previous&&previous!==value.storageMachine)
    throw Error('Dataset upload storage identity is unconfirmed or changed; no data was redirected');
  return value.storageMachine;
}
export function validateUploadRoutes(value,machine){
  if(!value||value.available!==true||value.protocol!==protocol||value.machine!==machine||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(machine||'')||!hex.test(value.revision||'')||!hex.test(value.certificateSha256||'')||
    !Array.isArray(value.routes)||value.routes.length<1||value.routes.length>4)fail();
  const ids=new Set(),origins=new Set();
  const routes=value.routes.map((route,index)=>{
    let url;try{url=new URL(route.endpoint);}catch{fail();}
    if(Object.keys(route).sort().join(',')!=='endpoint,id,kind'||!id.test(route.id)||ids.has(route.id)||
      !['campus-direct','tail-upload'].includes(route.kind)||index===0&&(route.id!=='primary'||route.kind!=='campus-direct')||
      url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin!==route.endpoint||origins.has(url.origin))fail();
    if(route.id==='node-lan'){
      const parts=url.hostname.split('.');const [a,b]=parts.map(Number);
      if(parts.length!==4||parts.some(p=>!/^(0|[1-9][0-9]{0,2})$/.test(p)||Number(p)>255)||!(a===10||a===172&&b>=16&&b<=31||a===192&&b===168))fail();
    }
    ids.add(route.id);origins.add(url.origin);
    return Object.freeze({...route,protocol,machine,revision:value.revision,certificateSha256:value.certificateSha256});
  });
  return routes;
}
export async function selectUploadRoute(value,machine,probe,{signal}={}){
  // Validate legacy descriptors completely, but never probe their Tail routes.
  // Ordinary members only need a reachable campus HTTPS entry.
  const approved=validateUploadRoutes(value,machine).filter(route=>route.kind==='campus-direct');
  const primary=approved[0],lan=approved.find(route=>route.id==='node-lan');
  const routes=lan?[lan,primary]:approved,routeFailures=[];
  for(const route of routes){
    if(signal?.aborted)throw signal.reason||Error('Upload canceled');
    try{
      const candidate=lan?{...primary,dialEndpoint:route.endpoint,probeTimeoutMs:route.id==='node-lan'?1000:2500}:route;
      const observed=await probe(candidate);
      if(observed?.protocol===protocol&&observed.listenerReady===true&&observed.machine===machine&&observed.revision===route.revision)
        return lan?{...primary,dialEndpoint:route.endpoint,routes:[primary,lan].map(({id,kind,endpoint})=>({id,kind,endpoint}))}:route;
      const code=observed?.protocol!==protocol?'PROTOCOL_MISMATCH':observed.listenerReady!==true?'LISTENER_NOT_READY':
        observed.machine!==machine?'NODE_MISMATCH':'REVISION_MISMATCH';
      routeFailures.push({routeId:route.id,code});
    }catch(error){
      // Anonymous bounded probe only; no writes are retried here.
      routeFailures.push({routeId:route.id,code:uploadProbeFailureCode(error)});
    }
  }
  if(signal?.aborted)throw signal.reason||Error('Upload canceled');
  const summary=routeFailures.map(({routeId,code})=>`${routeId}: ${probeFailures[code]}`).join('; ');
  throw Object.assign(Error(`No approved upload endpoint passed the node/revision probe; no ticket issued and no VPS fallback was attempted (${summary})`),{routeFailures});
}
export function assertUploadRouteGrant(grant,route){
  if(route&&(['endpoint','machine','revision','certificateSha256','kind'].some(key=>grant[key]!==route[key])||grant.routeId!==route.id))
    throw Error('Upload destination changed after probing; reselect a route before sending file bytes');
  return grant;
}
