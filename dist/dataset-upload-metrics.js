// Only confirmed file offsets contribute to progress. Hashing and manifest
// bytes describe different work and must never become upload percentages.
export function createUploadMeter(now=()=>performance.now()){
  let first=null,last=null;
  function reset(){first=null;last=null;}
  function report(value){
    if(value?.state!=='UPLOADING')return last;
    const {bytes,totalBytes}=value;
    if(!Number.isSafeInteger(bytes)||!Number.isSafeInteger(totalBytes)||bytes<0||totalBytes<0||bytes>totalBytes)return last;
    const time=now();
    if(!Number.isFinite(time)||last&&(bytes<last.bytes||totalBytes!==last.totalBytes||time<last.time))return last;
    if(!first)first={bytes,time};
    const elapsed=(time-first.time)/1000,delta=bytes-first.bytes;
    const speed=elapsed>0&&delta>0?delta/elapsed:null;
    last={bytes,totalBytes,time,percent:totalBytes>0?Math.floor(bytes/totalBytes*100):null,speed,seconds:speed===null?null:Math.ceil((totalBytes-bytes)/speed)};
    return last;
  }
  return {reset,report,get value(){return last;}};
}
