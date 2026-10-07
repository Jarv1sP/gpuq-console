// Observe the fixed cache target. This controller never dispatches or retries a write.
const id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,hash=/^[a-f0-9]{64}$/;
const key=ref=>JSON.stringify([ref.machine,ref.dataset,ref.version]);
const number=value=>Number.isSafeInteger(value)&&value>=0;
const terminal=state=>state==='READY'||state==='FAILED';
export function cacheProgress(value,total){
 const size=number(value?.totalBytes)?value.totalBytes:total;
 const done=number(value?.bytes)&&number(value?.totalBytes)?value.bytes:number(value?.remainingBytes)&&number(size)?size-value.remainingBytes:null;
 return number(size)&&number(done)&&done<=size?{bytes:done,totalBytes:size}:null;
}
export function datasetCacheWatch({call,identity,active,allowed,onChange=()=>{},onReady=()=>{},delay=1500,schedule=setTimeout,cancel=clearTimeout}){
 const entries=new Map();let timer=null,running=false,generation=0,owner=identity();
 const live=()=>identity()===owner&&active();
 function sync(){if(timer!==null){cancel(timer);timer=null;}if(live()&&[...entries.values()].some(row=>!terminal(row.state)&&!row.paused&&allowed(row.machine))&&!running)timer=schedule(()=>{timer=null;void poll();},Math.min(15000,delay*2**Math.min(4,Math.max(0,...[...entries.values()].map(row=>row.errors||0)))));}
 function changed(){if(live())onChange();sync();}
 function begin(ref,{dispatching=false}={}){
  if(identity()!==owner)reset();
  if(!live()||!allowed(ref.machine)||!id.test(ref.machine)||!id.test(ref.dataset)||!hash.test(ref.version))return null;
  const existing=entries.get(key(ref));if(existing&&!terminal(existing.state))return null;
  const row={...ref,state:'PREPARING',progress:null,error:null,dispatching};entries.set(key(ref),row);changed();return row;
 }
 function valid(row,token=generation){return generation===token&&identity()===owner&&entries.get(key(row))===row&&allowed(row.machine);}
 function accept(row,value){
  if(!valid(row))return;
  if(!value||![row.dataset,row.physicalDataset].includes(value.dataset)||value.version!==row.version||row.operationId&&value.operationId&&row.operationId!==value.operationId){row.state='UNKNOWN';row.error='取回回执未确认';row.progress=null;changed();return;}
  if(hash.test(value.operationId||''))row.operationId=value.operationId;
  row.state=['READY','FAILED','PREPARING'].includes(value.state)?value.state:'UNKNOWN';
  row.error=typeof value.error==='string'?value.error:null;
  row.progress=row.state==='PREPARING'?cacheProgress(value,row.totalBytes):null;
  row.errors=0;changed();if(row.state==='READY'&&live())void Promise.resolve().then(()=>{if(valid(row)&&live())return onReady();}).catch(()=>{});
 }
 function settled(row,value,error){if(!valid(row))return;row.dispatching=false;if(error){row.state='UNKNOWN';row.error=error.message;row.progress=null;changed();}else accept(row,value);}
 async function poll(){
  if(running||!live())return;running=true;const token=generation;
  try{for(const row of entries.values()){
   if(!live()||token!==generation)break;
   if(terminal(row.state)||row.paused||row.dispatching||!allowed(row.machine))continue;
   try{
    let value;
    if(row.operationId){
     try{value=await call('datasets.status',{machine:row.machine,operationId:row.operationId});}
     catch(error){if(![403,404].includes(error.status))throw error;if(!valid(row,token)||!live())break;value=await call('datasets.status',{machine:row.machine,dataset:row.dataset,version:row.version});}
    }else value=await call('datasets.status',{machine:row.machine,dataset:row.dataset,version:row.version});
    if(valid(row,token)&&live())accept(row,value);
   }catch(error){if(valid(row,token)&&live()){row.state='UNKNOWN';row.progress=null;row.error=error.message;row.errors=(row.errors||0)+1;row.paused=[401,403].includes(error.status);onChange();}}
  }}finally{running=false;sync();}
 }
 function catalog(rows){
  if(identity()!==owner){reset();return;}
  for(const ref of rows){const row=entries.get(key(ref));
   if(row&&!row.dispatching&&(terminal(ref.state)||row.state==='READY'))entries.delete(key(ref));
   else if(row?.paused&&ref.state==='PREPARING'&&ref.canUse&&allowed(ref.machine))row.paused=false;
  }sync();
 }
 function reset(){generation++;owner=identity();entries.clear();if(timer!==null)cancel(timer);timer=null;}
 return {begin,settled,poll,sync,catalog,reset,get:ref=>entries.get(key(ref))};
}
