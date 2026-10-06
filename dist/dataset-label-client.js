// No DOM, persistence, new endpoint, automatic rename or guessed revision.
// identity() supplies {userId, role, authGeneration} from the current store.
const id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const fail=(message,code='LABEL_UNCONFIRMED')=>Object.assign(Error(message),{code});
export function normalizeDatasetDisplayName(value){
  if(typeof value!=='string'||/[\p{Cc}\p{Cf}]/u.test(value))throw fail('显示名不能包含控制或不可见字符。','LABEL_NAME_INVALID');
  const result=value.normalize('NFC').trim();
  if([...result].length<1||[...result].length>80)throw fail('显示名需为 1–80 个可见字符。','LABEL_NAME_INVALID');
  return result;
}

export function datasetLabelClient({call,identity}){
  if(typeof call!=='function'||typeof identity!=='function')throw TypeError('Label call and current identity are required');
  const snapshots=new WeakMap(),latest=new Map(),reading=new Map(),writing=new Set();let epoch=0,serial=0;
  function actor(){
    const value=identity();
    if(!value||typeof value.userId!=='string'||!value.userId||!Number.isSafeInteger(value.authGeneration)||value.authGeneration<0)
      throw fail('请先登录并重新读取名称。','LABEL_IDENTITY_CHANGED');
    return {userId:value.userId,role:value.role,authGeneration:value.authGeneration};
  }
  const stamp=who=>JSON.stringify([who.userId,who.role,who.authGeneration,epoch]);
  const valid=token=>{if(stamp(actor())!==token)throw fail('账号已改变，请重新读取名称。','LABEL_IDENTITY_CHANGED');};
  function target(value,who){
    if(!value||!id.test(value.machine||'')||!id.test(value.dataset||''))throw TypeError('A catalog machine and dataset ID are required');
    const result={machine:value.machine,dataset:value.dataset};
    if(value.ownerId!==undefined){
      if(typeof value.ownerId!=='string'||!value.ownerId||value.ownerId!==who.userId&&who.role!=='admin')
        throw fail('不能修改其他账号的个人显示名。','LABEL_OWNER_MISMATCH');
      result.ownerId=value.ownerId;
    }
    return result;
  }
  const key=(args,token)=>JSON.stringify([token,args.machine,args.dataset,args.ownerId]);
  function receipt(value,args,who,expectedDataset){
    const owner=args.ownerId??who.userId;
    if(!value||!id.test(value.dataset||'')||expectedDataset&&value.dataset!==expectedDataset||
      value.scope!=='personal'||value.ownerId!==owner||!Number.isSafeInteger(value.revision)||value.revision<0||
      value.revision>=Number.MAX_SAFE_INTEGER||!(value.displayName===null||typeof value.displayName==='string'))
      throw fail('显示名返回身份或版本未确认，请重新读取。');
    const name=value.displayName===null?value.dataset:normalizeDatasetDisplayName(value.displayName);
    if(name!==value.name||value.displayName!==null&&name!==value.displayName)throw fail('显示名返回内容未确认，请重新读取。');
    return Object.freeze({machine:args.machine,dataset:value.dataset,ownerId:owner,scope:'personal',
      displayName:value.displayName,name,revision:value.revision});
  }
  async function get(value){
    const who=actor(),token=stamp(who),args=target(value,who),readKey=key(args,token),request=++serial;
    reading.set(readKey,request);
    const response=await call('datasets.label.get',args);valid(token);
    if(reading.get(readKey)!==request)throw fail('旧名称查询已过期，请使用最新读取。','LABEL_STALE_READ');
    const result=receipt(response,args,who),scope=key({...args,dataset:result.dataset},token);
    if(writing.has(scope))throw fail('名称正在保存，请稍后重新读取。','LABEL_BUSY');
    snapshots.set(result,{args:{...args,dataset:result.dataset},who,token,scope});latest.set(scope,result);
    return result;
  }
  async function set(snapshot,displayName){
    const held=snapshot&&snapshots.get(snapshot);
    if(!held)throw fail('先读取当前显示名，再保存。','LABEL_READ_REQUIRED');
    valid(held.token);
    if(writing.has(held.scope))throw fail('名称正在保存，请勿重复提交。','LABEL_BUSY');
    if(latest.get(held.scope)!==snapshot)throw fail('先重新读取名称，再决定是否保存。','LABEL_READ_REQUIRED');
    const name=normalizeDatasetDisplayName(displayName);writing.add(held.scope);latest.delete(held.scope);
    try{
      const response=await call('datasets.label.set',{...held.args,displayName:name,revision:snapshot.revision});valid(held.token);
      const result=receipt(response,held.args,held.who,snapshot.dataset);
      if(result.revision!==snapshot.revision+1||result.displayName!==name)throw fail('保存结果未确认，请重新读取。');
      // The saved receipt is display evidence. A later edit still starts GET.
      return {status:'SAVED',label:result};
    }catch(error){
      valid(held.token);
      if(error.status!==409)throw error;
      // Only read again on CAS conflict. Never retry SET without a new decision.
      writing.delete(held.scope);
      try{return {status:'CONFLICT',label:await get(held.args),attemptedName:name,refreshError:null};}
      catch(refreshError){valid(held.token);return {status:'CONFLICT',label:null,attemptedName:name,refreshError};}
    }finally{writing.delete(held.scope);}
  }
  function reset(){epoch++;latest.clear();reading.clear();writing.clear();}
  return {get,set,reset};
}
