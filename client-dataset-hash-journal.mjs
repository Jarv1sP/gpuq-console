import {mkdir,lstat,open,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=()=>{throw Error('Dataset hash journal changed or is unsafe; original upload identity retained');};
const stable=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
const privateMode=info=>process.platform==='win32'||(!(info.mode&0o077n)&&info.uid===BigInt(process.getuid()));

export function originalDatasetUploadId(session,{userId,machine,name}){
  // An issued UUID is already durable in the admission intent. The first
  // status may fail before a handle can be saved; reuse that exact intent.
  const candidates=Object.entries(session.datasetUploadIntents||{}).filter(([key,row])=>row?.protocol===1&&row.userId===userId&&row.machine===machine&&row.specification?.name===name&&UUID.test(row.uploadId||'')&&(!session.datasetUploadHandles?.[key]||session.datasetUploadHandles[key].uploadId===row.uploadId));
  return candidates.length===1?candidates[0][1].uploadId:undefined;
}

// Cache keys include all source metadata already protected by the scanner.
// BigInt file IDs/timestamps are serialized as strings without rounding.
export function datasetHashStamp(path,info,handleInfo){
  return digest([path,...[info,handleInfo].map(row=>['dev','ino','mode','size','mtimeNs','ctimeNs','nlink'].map(key=>String(row[key])))]);
}

export function createDatasetHashJournal({base,origin,userId,machine,name,root,uploadId,manifestSha256}){
  if(uploadId!==undefined&&!UUID.test(uploadId))fail();
  if(manifestSha256!==undefined&&!HASH.test(manifestSha256))fail();
  const context=digest([origin,userId,machine,name,resolve(root)]),entries=new Map();let bound=uploadId,folder,prepared;
  const prepare=()=>prepared??=(async()=>{
    if(!bound)return;
    let path=base;
    for(const part of ['dataset-upload-journals',bound,'hashes',context]){
      path=join(path,part);
      try{await mkdir(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
      const info=await lstat(path,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink()||!privateMode(info))fail();
    }
    folder=path;
  })();
  const record=value=>({schema:1,uploadId:bound,context,...value});
  const write=async value=>{
    if(!bound)return;
    await prepare();const path=join(folder,value.stamp+'.json'),pending=path+'.pending-'+randomUUID(),file=await open(pending,'wx',0o600);
    try{
      await file.writeFile(JSON.stringify(record(value)));await file.sync();await file.close();await rename(pending,path);
      let directory;try{directory=await open(folder,'r');await directory.sync();}
      catch(error){if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL'].includes(error.code))throw error;}
      finally{await directory?.close();}
    }
    finally{await file.close().catch(()=>{});await unlink(pending).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  };
  return {
    async get(stamp){
      if(!HASH.test(stamp))fail();if(entries.has(stamp))return entries.get(stamp).sha256;if(!bound)return;
      await prepare();const path=join(folder,stamp+'.json');let before,file;
      try{before=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>4096n||!privateMode(before))fail();
      try{
        file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
        const opened=await file.stat({bigint:true});
        // Windows path/handle volume serials can use different bit widths.
        const sameDevice=before.dev===opened.dev||process.platform==='win32'&&(before.dev===0n||BigInt.asUintN(32,before.dev)===BigInt.asUintN(32,opened.dev));
        if(!sameDevice||!stable({...before,dev:opened.dev},opened))fail();
        const buffer=Buffer.alloc(4097),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>4096)fail();
        const raw=buffer.subarray(0,bytesRead).toString('utf8');if(!stable(opened,await file.stat({bigint:true}))||!stable(before,await lstat(path,{bigint:true})))fail();
        let value;try{value=JSON.parse(raw);}catch{return;}
        if(value?.schema!==1||value.uploadId!==bound||value.context!==context||value.stamp!==stamp||!HASH.test(value.sha256||''))return;
        entries.set(stamp,{stamp,sha256:value.sha256});return value.sha256;
      }finally{await file?.close();}
    },
    async set(stamp,sha256){if(!HASH.test(stamp)||!HASH.test(sha256))fail();const value={stamp,sha256};entries.set(stamp,value);await write(value);},
    async bind(id){if(!UUID.test(id))fail();if(bound===id)return;bound=id;folder=undefined;prepared=undefined;for(const value of entries.values())await write(value);},
    get uploadId(){return bound;},expectedManifestSha256:manifestSha256
  };
}
