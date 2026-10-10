import {setTimeout as wait} from 'node:timers/promises';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const quote=value=>"'"+String(value).replaceAll("'","'\"'\"'")+"'";
export const publicationStatusCommand=({machine,project})=>`gpuctl project status --machine ${quote(machine)} --project ${quote(project)}`;
export const publicationUnconfirmed=intent=>Object.assign(Error(`发布结果待确认（原 UUID ${intent.key}）。查询：${publicationStatusCommand(intent)}；不要换 key 重复发布。`),
  {publication:{id:intent.key,machine:intent.machine,project:intent.project,state:'UNKNOWN',statusCommand:publicationStatusCommand(intent)}});
const unconfirmed=publicationUnconfirmed;

// A publication is the only write in this flow. A lost acknowledgement is
// followed by one read-only observation of this project, bound to the exact
// original UUID. A previous READY release is never evidence of success.
export async function requestProjectPublication(call,intent,{signal,progress=()=>{},saveIntent=async()=>{}}={}){
  if(!UUID.test(intent.key||''))throw Error('--key must be a UUID');
  await saveIntent(intent);
  progress(`Publication key: ${intent.key}\n`);
  const args={machine:intent.machine,project:intent.project,key:intent.key,
    ...(intent.inheritRelease===undefined?{}:{inheritRelease:intent.inheritRelease})};
  let result,recovered=false;
  try{result=(await call('projects.publish',args,signal)).result;}
  catch(error){
    // Definitive refusals are not uncertain writes. Never replay either kind.
    if(Number.isInteger(error.status)&&error.status<500)throw error;
    if(signal?.aborted)throw unconfirmed(intent);
    progress('发布回执中断，正在查询原 UUID。\n');
    try{result=(await call('projects.status',{machine:intent.machine,project:intent.project},signal)).result;recovered=true;}
    catch{throw unconfirmed(intent);}
  }
  if(result?.publicationProtocol!==1||result.project!==intent.project||result.publication?.id!==intent.key)throw unconfirmed(intent);
  if(recovered)progress('已查到原发布回执，正在核对结果。\n');
  return result;
}

export async function publishProject(call,intent,{signal,pollMs=1000,timeoutMs=7200000,progress=()=>{},saveIntent}={}){
  const combined=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeoutMs)]);
  let result=await requestProjectPublication(call,intent,{signal:combined,progress,saveIntent});
  while(true){
    const proof=result?.publication;
    if(result?.publicationProtocol!==1||result.project!==intent.project||proof?.id!==intent.key)throw unconfirmed(intent);
    if(proof.state==='READY'){
      if(result.state!=='READY'||!HASH.test(proof.release||'')||!result.releases?.some(row=>row.release===proof.release&&row.state==='READY'))throw unconfirmed(intent);
      return result;
    }
    if(proof.state==='FAILED')throw Object.assign(Error(`发布失败：${result.error||proof.error||'请查询原发布状态'}`),{publication:{id:intent.key,state:'FAILED',machine:intent.machine,project:intent.project,statusCommand:publicationStatusCommand(intent)}});
    if(proof.state!=='PUBLISHING'||result.state!=='PUBLISHING')throw unconfirmed(intent);
    try{
      await wait(pollMs,undefined,{signal:combined});
      result=(await call('projects.status',{machine:intent.machine,project:intent.project},combined)).result;
    }catch{throw unconfirmed(intent);}
  }
}
