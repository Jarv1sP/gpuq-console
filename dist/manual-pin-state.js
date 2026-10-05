const key=target=>JSON.stringify([target.machine,target.dataset,target.version]);
const reference=value=>value&&typeof value.machine==='string'&&value.machine.length>0&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.dataset)&&/^[a-f0-9]{64}$/.test(value.version);
export const retentionStorageKey=userId=>'stargate.manual-pins.v1:'+encodeURIComponent(userId);
const browserStorage={getItem:key=>globalThis.localStorage.getItem(key),setItem:(key,value)=>globalThis.localStorage.setItem(key,value)};
const browserLock=(name,task)=>{if(!globalThis.navigator?.locks)throw Error('浏览器无法锁定保留记录；不能修改保留。');return navigator.locks.request(name,task);};

// A local journal remembers a request, not authorization or current server
// state. Reloaded records always require an exact, owner-checked status read.
export function cacheRetentionSession({call,allowed,identity,storage=browserStorage,lock=browserLock,uuid=()=>crypto.randomUUID()}){
  const records=new Map(),observed=new Map(),busy=new Set(),queued=new Map();let generation=0,owner=null,storageError=null,lastRaw;
  function sync(){
    const next=identity();if(next!==owner){generation++;owner=next;records.clear();observed.clear();busy.clear();storageError=null;lastRaw=undefined;}
    if(!owner)return;
    try{
      const raw=storage.getItem(retentionStorageKey(owner));if(raw===lastRaw)return;
      generation++;records.clear();observed.clear();busy.clear();storageError=null;lastRaw=raw;if(raw===null)return;
      if(raw.length>2**21)throw Error();const rows=JSON.parse(raw);
      if(!Array.isArray(rows)||rows.length>2000)throw Error();
      for(const row of rows){
        if(!reference(row)||row.owner!==owner||!/^manual-[A-Za-z0-9_-]{1,57}$/.test(row.pinId)||!['pin','unpin'].includes(row.intent)||records.has(key(row)))throw Error();
        records.set(key(row),{...row,phase:'uncertain'});
      }
    }catch{records.clear();storageError='本地保留记录无法读取；请先恢复记录，不能新建保留。';}
  }
  function save(){
    if(storageError)throw Error(storageError);
    try{const raw=JSON.stringify([...records.values()]);if(raw.length>2**21||records.size>2000)throw Error();storage.setItem(retentionStorageKey(owner),raw);lastRaw=raw;}
    catch{storageError='无法持久保存保留请求；未继续写入服务器。';throw Error(storageError);}
  }
  const state=target=>{sync();return {record:records.get(key(target))||null,status:observed.get(key(target))||null,busy:busy.has(key(target))||queued.has(key(target)),error:storageError};};
  async function perform(target,action){
    sync();const id=key(target),epoch=generation,expected=owner;let writeIssued=false;
    const check=()=>{if(identity()!==expected||!expected||epoch!==generation||!allowed(target))throw Error('账号、页面或服务器授权已改变，请重新查询。');};
    check();if(!reference(target))throw Error('数据版本无效。');if(storageError)throw Error(storageError);
    if(busy.has(id))throw Error('请等待当前确认完成。');busy.add(id);
    const request=async(operation,args)=>{check();const result=await call(operation,args);check();return result;};
    const query=async()=>{
      observed.delete(id);const record=records.get(id);if(record)record.phase='uncertain';
      const result=await request('datasets.storage.status',{...target,...(record?{pinId:record.pinId}:{})});
      if(result?.version?.dataset!==target.dataset||result.version.version!==target.version||result.version.manualPinProtocol!==1)throw Error('节点尚未确认精确保留协议；不能修改保留。');
      if(record){
        const proof=result.version.manualPin;
        if(proof?.pinId!==record.pinId||proof.owner!==expected||typeof proof.present!=='boolean')throw Error('本账号的精确保留状态未确认。');
        record.phase=record.intent==='pin'?(proof.present?'retained':'uncertain'):(proof.present?'uncertain':'released');save();
      }
      observed.set(id,result);return result;
    };
    try{
      if(action==='query'){await query();return state(target);}
      let record=records.get(id);
      if(action==='retry'){
        if(!record||record.phase!=='uncertain')throw Error('没有待确认的原请求。');
        await query();if(record.phase!=='uncertain')return state(target);
      }else if(action==='pin'){
        if(record&&record.phase!=='released')throw Error('请先确认原保留请求。');
        const before=await query();if(before.version.state!=='READY')throw Error('缓存就绪后才能固定保留。');
        record={...target,owner:expected,pinId:'manual-'+uuid(),intent:'pin',phase:'uncertain',receipt:null};
        if(!/^manual-[A-Za-z0-9_-]{1,57}$/.test(record.pinId))throw Error('保留请求编号无效。');
        records.set(id,record);save();
        await query();if(record.phase==='retained')throw Error('请求编号已存在；未新建保留。');
      }else if(action==='unpin'){
        if(!record||record.phase!=='retained')throw Error('只能解除已查询确认的本人保留。');
        await query();if(record.phase!=='retained')throw Error('本人保留已改变，请重新查询。');
        record={...record,intent:'unpin',phase:'uncertain',receipt:null};records.set(id,record);
      }else throw Error('未知操作。');
      if(record.intent==='pin'&&observed.get(id)?.version.state!=='READY')throw Error('缓存就绪后才能固定保留。');
      record.phase='uncertain';record.receipt=null;save();check();
      writeIssued=true;record.receipt=await request('datasets.storage.'+record.intent,{...target,pinId:record.pinId});save();
      await query();return state(target);
    }catch(error){
      if(epoch===generation&&identity()===expected){
        observed.delete(id);if(records.has(id))records.get(id).phase='uncertain';
        // No write replay. An exact read can settle a lost reply, but leaving
        // this page or changing principal prevents even the follow-up read.
        if(writeIssued&&allowed(target))try{await query();if(records.get(id)?.phase!=='uncertain')return state(target);}catch{}
      }
      throw error;
    }finally{if(epoch===generation)busy.delete(id);}
  }
  async function run(target,action){
    sync();const expected=owner,epoch=generation,id=key(target);
    if(!expected||!allowed(target))throw Error('账号、页面或服务器授权已改变，请重新查询。');
    if(queued.has(id))throw Error('请等待当前确认完成。');const token=Symbol();queued.set(id,token);
    try{return await lock(retentionStorageKey(expected),()=>{
      if(identity()!==expected||epoch!==generation||!allowed(target))throw Error('账号、页面或服务器授权已改变，请重新查询。');
      // Cross-tab operations share this lock; perform reloads any newer journal
      // before deciding whether a new ID or a mutation is permitted.
      return perform(target,action);
    });}finally{if(queued.get(id)===token)queued.delete(id);}
  }
  return {state,query:target=>run(target,'query'),pin:target=>run(target,'pin'),unpin:target=>run(target,'unpin'),retry:target=>run(target,'retry'),reset(){generation++;owner=null;records.clear();observed.clear();busy.clear();queued.clear();storageError=null;lastRaw=undefined;}};
}
