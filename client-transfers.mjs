import {mkdir,lstat,open,rename,unlink,link} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {remoteSnapshot} from './client-snapshot-sync.mjs';
import {dataPath,scanLocalDataset,uploadDatasetSnapshot,snapshotKey,DATA_CHUNK,sameDatasetFile} from './client-data-upload.mjs';
import {transferUploadCall} from './dist/transfer-upload.js';
const fail=message=>{throw Error(message);};
const safe=value=>String(value??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>'\\u{'+c.codePointAt(0).toString(16)+'}');
export function transferText(row){const result=row.result||{},bytes=result.bytes??(result.totalBytes!==undefined&&result.remainingBytes!==undefined?result.totalBytes-result.remainingBytes:0),total=result.totalBytes??row.snapshot?.totalBytes??row.manifest?.totalBytes;return `${safe(row.id)} · ${safe(row.kind)} · ${safe(row.from?row.from+' → '+row.machine:row.machine)} · ${safe(row.state)}\n  ${bytes} / ${total??'?'} bytes${result.path?' · '+safe(result.path):''}${row.error||result.error?'\n  '+safe(row.error||result.error):''}`;}
export async function uploadTransfer(call,{machine,name,userId,directory,progress=()=>{},key}){
  const scan=await scanLocalDataset(directory,progress);let handle;
  const adapter=transferUploadCall(async(op,args)=>(await call(op,args)).result,row=>{handle=row;progress('HANDLE',{transferId:row.id});});
  try{return {...await uploadDatasetSnapshot(async(op,args)=>({result:await adapter(op,args)}),{machine,name,userId,scan,progress,keyStore:{get:()=>key,set:async()=>fail('Canceled upload cannot be silently replaced')}}),transferId:handle.id};}
  catch(error){throw Error(error.message+(handle?'\n传输：'+handle.id+'；gpuctl transfer status '+handle.id:''));}
}
async function exists(path){try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function realDirectory(path){const value=await lstat(path);if(!value.isDirectory()||value.isSymbolicLink())fail('Unsafe local download directory: '+path);}
async function readReceipt(path,expected){
  let file;
  try{
    file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
    const info=await file.stat({bigint:true}),named=await lstat(path,{bigint:true});
    if(!info.isFile()||named.isSymbolicLink()||info.nlink!==1n||info.size>1024n||!sameDatasetFile(named,info,{pathToHandle:true}))fail('Unsafe download receipt');
    const bytes=Buffer.alloc(1025),{bytesRead}=await file.read(bytes,0,bytes.length,0);
    if(BigInt(bytesRead)!==info.size||!sameDatasetFile(info,await file.stat({bigint:true}))||!sameDatasetFile(named,await lstat(path,{bigint:true})))fail('Download receipt changed while reading');
    const value=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
    if(!value||Object.keys(value).sort().join(',')!=='id,manifestSha256'||value.id!==expected.id||value.manifestSha256!==expected.manifestSha256)fail('Existing download receipt belongs to different content; no overwrite performed');
    return value;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
  finally{await file?.close();}
}
async function publishReceipt(path,value){
  // A private random inode is fully written before publishing. Hard-link
  // publication is atomic and exclusive on POSIX and Windows NTFS; unlike
  // rename(), it cannot replace an existing destination or follow a symlink.
  if(await readReceipt(path,value))return;
  const pending=path+'.pending-'+randomUUID();
  const file=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);
  try{
    await file.writeFile(JSON.stringify(value));await file.sync();await file.close();
    try{await link(pending,path);}catch(error){if(error.code!=='EEXIST'||!await readReceipt(path,value))throw error;}
  }finally{await file.close().catch(()=>{});await unlink(pending);}
}
async function hashFile(file,size){const buffer=Buffer.alloc(DATA_CHUNK),hash=createHash('sha256');for(let at=0;at<size;){const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,size-at),at);if(!bytesRead)fail('Incomplete local file');hash.update(buffer.subarray(0,bytesRead));at+=bytesRead;}return hash.digest('hex');}
function codepointOrder(a,b){const x=Array.from(a),y=Array.from(b);for(let i=0;i<Math.min(x.length,y.length);i++){const n=x[i].codePointAt(0)-y[i].codePointAt(0);if(n)return n;}return x.length-y.length;}
function canonicalDigest(raw){const m=JSON.parse(raw);return createHash('sha256').update(JSON.stringify({directories:m.directories.sort(codepointOrder),files:m.files.sort((a,b)=>codepointOrder(a.path,b.path)).map(({path,size,sha256})=>({path,sha256,size})),schema:1})).digest('hex');}
export async function downloadTransfer(call,{machine,dataset,version,destination,key,progress=()=>{}}){
  key||=snapshotKey(['download',machine,dataset,version,resolve(destination)]);
  const row=(await call('transfers.create',{key,kind:'download',machine,dataset,version})).result;progress('HANDLE',{transferId:row.id});
  const target=resolve(destination),partial=target+'.gpuq-partial-'+row.id;
  if(row.state==='CANCELED'||row.cancelRequested)fail('Download was canceled; partial files were retained');
  if(row.state==='UNKNOWN'||!row.snapshot)fail('Download source unconfirmed; repeat original command. Transfer: '+row.id);
  const receiptPath=target+'.gpuq-receipt.json',expectedReceipt={id:row.id,manifestSha256:row.snapshot.manifestSha256};
  const receipt=await readReceipt(receiptPath,expectedReceipt);
  const recovered=receipt?.id===row.id&&receipt.manifestSha256===row.snapshot.manifestSha256&&!!await exists(target);
  const finalized=row.state==='SUCCEEDED'||recovered;if(await exists(target)&&!finalized)fail('Destination already exists; choose a NEW directory (no overwrite)');
  if(!finalized){await mkdir(dirname(target),{recursive:true});await mkdir(partial,{mode:0o700,recursive:true});await realDirectory(partial);}
  const root=finalized?target:partial;await realDirectory(root);
  const lockPath=root+'.gpuq-client-lock';let lock;
  try{lock=await open(lockPath,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;fail('Another client or interrupted-client lock exists: '+lockPath+'; confirm the old client stopped before removing ONLY this lock');}
  await lock.writeFile(JSON.stringify({pid:process.pid,id:row.id}));
  const controller=new AbortController(),stop=()=>controller.abort(Error('Local client interrupted; partial payload retained'));
  const signals=['SIGINT','SIGTERM','SIGHUP'];for(const signal of signals)process.on(signal,stop);
  const request=(op,args)=>{if(controller.signal.aborted)throw controller.signal.reason;return call(op,args,controller.signal);};
  try{
    if(finalized){const scan=await scanLocalDataset(root,()=>{});if(canonicalDigest(scan.manifest)!==row.snapshot.manifestSha256)fail('Completed local directory changed; choose a new destination and key');if(row.state!=='SUCCEEDED')await call('transfers.progress',{id:row.id,bytes:scan.totalBytes,complete:true});return {transferId:row.id,state:'SUCCEEDED',downloaded:target,bytes:scan.totalBytes};}
    const adapter=async(op,args)=>{const action=op.slice('datasets.snapshot.'.length),{machine,dataset,version,...fields}=args;return request('transfers.io',{id:row.id,action,...fields});};
    const scan=await remoteSnapshot(adapter,'datasets',{machine,dataset,version},progress),manifest=JSON.parse(scan.manifest);
    if(scan.manifestSha256!==row.snapshot.manifestSha256)fail('Fixed source manifest changed after transfer registration');
    const names=new Set();for(const path of [...manifest.directories,...manifest.files.map(f=>f.path)]){dataPath(path);if(names.has(path))fail('Duplicate manifest path');names.add(path);}
    for(const folder of manifest.directories){await mkdir(join(root,folder),{recursive:true,mode:0o700});await realDirectory(join(root,folder));}
    let transferred=0,last=0;
    for(const entry of scan.files){
      const path=join(root,entry.path);await mkdir(dirname(path),{recursive:true,mode:0o700});await realDirectory(dirname(path));
      const prior=await exists(path);if(prior&&(!prior.isFile()||prior.isSymbolicLink()||prior.nlink!==1||prior.size>entry.size))fail('Unsafe or oversized local partial file: '+entry.path);
      const file=await open(path,(prior?constants.O_RDWR:constants.O_RDWR|constants.O_CREAT|constants.O_EXCL)|(constants.O_NOFOLLOW||0),0o600),source=await scan.openEntry(entry);
      try{
        let offset=(await file.stat()).size;transferred+=offset;
        while(offset<entry.size){const bytes=await source.read(offset);if(!bytes.length)fail('Source returned an incomplete file');let at=0;while(at<bytes.length){const {bytesWritten}=await file.write(bytes,at,bytes.length-at,offset+at);if(!bytesWritten)fail('Local write made no progress');at+=bytesWritten;}offset+=bytes.length;transferred+=bytes.length;await file.sync();progress('DOWNLOADING',{path:entry.path,bytes:transferred,totalBytes:scan.totalBytes});if(Date.now()-last>1000){await call('transfers.progress',{id:row.id,bytes:transferred,complete:false});last=Date.now();}}
        if(await hashFile(file,entry.size)!==entry.sha256)fail('Local SHA256 differs for '+entry.path+'; no success reported. Inspect/remove ONLY this partial file before retrying');await file.sync();
      }finally{await file.close();await source.close();}
    }
    await scan.verify();
    const verified=await scanLocalDataset(root,()=>{});if(canonicalDigest(verified.manifest)!==scan.manifestSha256)fail('Local directory differs from fixed snapshot');
    await publishReceipt(receiptPath,expectedReceipt);
    if(await exists(target))fail('Destination appeared during download; no overwrite performed');await rename(partial,target);
    await call('transfers.progress',{id:row.id,bytes:transferred,complete:true});return {transferId:row.id,state:'SUCCEEDED',downloaded:target,bytes:transferred};
  }catch(error){throw Error(error.message+'\n传输：'+row.id+'；重新执行原 download 命令续传。断点目录：'+partial);}
  finally{for(const signal of signals)process.off(signal,stop);await lock.close();await unlink(lockPath);}
}
