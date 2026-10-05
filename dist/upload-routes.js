// Candidates originate only in authenticated node configuration. This module
// never accepts a user URL, changes an OS route, or issues an upload ticket.
const protocol='dataset-upload-v1',hex=/^[a-f0-9]{64}$/,id=/^[a-z][a-z0-9-]{0,31}$/;
const fail=()=>{throw Error('Approved upload routes are invalid or unavailable; no VPS fallback was attempted');};
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
    ids.add(route.id);origins.add(url.origin);
    return Object.freeze({...route,protocol,machine,revision:value.revision,certificateSha256:value.certificateSha256});
  });
  return routes;
}
export async function selectUploadRoute(value,machine,probe,{signal}={}){
  const routes=validateUploadRoutes(value,machine);
  for(const route of routes){
    if(signal?.aborted)throw signal.reason||Error('Upload canceled');
    try{
      const observed=await probe(route);
      if(observed?.protocol===protocol&&observed.listenerReady===true&&observed.machine===machine&&observed.revision===route.revision)
        return route;
    }catch{ /* Anonymous bounded probe only; no writes are retried here. */ }
  }
  if(signal?.aborted)throw signal.reason||Error('Upload canceled');
  throw Error('No approved upload endpoint passed the node/revision probe; no ticket issued and no VPS fallback was attempted');
}
export function assertUploadRouteGrant(grant,route){
  if(route&&(['endpoint','machine','revision','certificateSha256','kind'].some(key=>grant[key]!==route[key])||grant.routeId!==route.id))
    throw Error('Upload destination changed after probing; reselect a route before sending file bytes');
  return grant;
}
