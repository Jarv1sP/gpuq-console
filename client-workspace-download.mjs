import {copyFile,open,unlink,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {downloadWorkspaceFile,workspacePath} from './dist/data-workspace.js';

// Existing workspace.get only. Never overwrite a caller's existing file;
// failures retain a clearly named partial file, never a success destination.
export async function getWorkspaceData(call,{machine,path,destination,signal,onProgress=()=>{}}){
  workspacePath(path);
  const target=resolve(destination),partial=join(dirname(target),'.stargate-recovery-'+randomUUID()+'.partial');
  try{await lstat(target);throw Error('目标文件已存在，请选择新的保存路径。');}catch(error){if(error.code!=='ENOENT')throw error;}
  let handle=await open(partial,'wx',0o600);
  try{
    const result=await downloadWorkspaceFile({machine,path,signal,onProgress,
      call:async(op,args)=>(await call(op,args)).result,
      write:async bytes=>{let at=0;while(at<bytes.length){const {bytesWritten}=await handle.write(bytes,at,bytes.length-at);if(!bytesWritten)throw Error('本机文件未完整写入。');at+=bytesWritten;}}});
    await handle.sync();await handle.close();handle=null;
    await copyFile(partial,target,constants.COPYFILE_EXCL);await unlink(partial);
    return {downloaded:target,...result};
  }catch(error){
    await handle?.close().catch(()=>{});
    error.message+=' · 未确认的本机片段保留在 '+partial;
    throw error;
  }
}
