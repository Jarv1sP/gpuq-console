import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,lstat,open,mkdtemp,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';

export const CAMPUS_GO_VERSION='go1.27.1';
// Verified against https://go.dev/dl/?mode=json&include=all. These are official
// archive checksums, not hashes inferred from an existing local installation.
export const CAMPUS_GO_ARCHIVES={
  'linux-x64':{filename:'go1.27.1.linux-amd64.tar.gz',sha256:'63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445'},
  'linux-arm64':{filename:'go1.27.1.linux-arm64.tar.gz',sha256:'3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec'},
  'darwin-x64':{filename:'go1.27.1.darwin-amd64.tar.gz',sha256:'8f8f52c6649542cf027bbc9b9c68d1ec042f9f34808a40413f0b8b3f66f3caa4'},
  'darwin-arm64':{filename:'go1.27.1.darwin-arm64.tar.gz',sha256:'ee215d57e0ec269c60cc9ceca68e6bda321ba9ee5afe24f4b0988703c2d87d12'},
  'win32-x64':{filename:'go1.27.1.windows-amd64.zip',sha256:'a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d'},
  'win32-arm64':{filename:'go1.27.1.windows-arm64.zip',sha256:'13b69b87bb0e83f96bc68560a8cace7f0343b1e03469f1110ea18d17e3234069'}
};
const version=program=>new Promise(resolve=>{const p=spawn(program,['version'],{env:{...process.env,GOTOOLCHAIN:'local'}});let output='';p.stdout.on('data',b=>output+=b);p.stderr.resume();p.once('error',()=>resolve(null));p.once('exit',code=>resolve(code===0?output.trim().split(/\s+/)[2]:null));});
const run=(program,args)=>new Promise((yes,no)=>{const p=spawn(program,args,{stdio:'inherit'});p.once('error',no);p.once('exit',code=>code===0?yes():no(Error('Verified Go archive extraction failed')));});
async function ordinaryBytes(path,maximum){
  const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink())throw Error('Unsafe Go cache file');
  const fd=await open(path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW|constants.O_NONBLOCK));
  try{const info=await fd.stat();if(!info.isFile()||info.dev!==before.dev||info.ino!==before.ino||info.nlink!==1||info.size>maximum||process.getuid&&((info.mode&0o022)||![0,process.getuid()].includes(info.uid)))throw Error('Unsafe Go cache file');return await fd.readFile();}finally{await fd.close();}
}
const binaryPath=(root,platform)=>join(root,'go','bin',platform==='win32'?'go.exe':'go');
async function verifiedCached(target,item,platform){
  for(const path of [target,join(target,'go'),join(target,'go/bin')]){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||process.getuid&&((info.mode&0o022)||![0,process.getuid()].includes(info.uid)))throw Error('Unsafe Go cache');}
  const proof=JSON.parse((await ordinaryBytes(join(target,'verified-source.json'),4096)).toString());
  if(proof.version!==CAMPUS_GO_VERSION||proof.filename!==item.filename||proof.sha256!==item.sha256||proof.source!=='https://go.dev/dl/?mode=json&include=all'||!/^[a-f0-9]{64}$/.test(proof.binarySha256||''))throw Error('Existing Go cache is unconfirmed');
  const tool=binaryPath(target,platform),bytes=await ordinaryBytes(tool,64*1024**2);
  if(createHash('sha256').update(bytes).digest('hex')!==proof.binarySha256)throw Error('Existing Go cache binary SHA mismatch');return tool;
}
const pending=new Map();
export async function campusGoToolchain({go=process.env.GO,root,platform=process.platform,arch=process.arch,fetchArchive=fetch,readVersion=version,extractArchive=run}={}){
  if(go){if(await readVersion(go)!==CAMPUS_GO_VERSION)throw Error('Campus build requires exact '+CAMPUS_GO_VERSION);return go;}
  if(await readVersion('go')===CAMPUS_GO_VERSION)return 'go';
  const item=CAMPUS_GO_ARCHIVES[`${platform}-${arch}`];if(!item)throw Error('Unsupported build host; provide an exact '+CAMPUS_GO_VERSION+' toolchain with GO');
  const base=resolve(root,'build/toolchains'),target=join(base,CAMPUS_GO_VERSION+'-'+platform+'-'+arch);
  if(pending.has(target))return pending.get(target);
  const work=(async()=>{
    await mkdir(base,{recursive:true,mode:0o700});
    const cached=binaryPath(target,platform);
    let present=true;try{await lstat(target);}catch(e){if(e.code!=='ENOENT')throw e;present=false;}
    if(present){await verifiedCached(target,item,platform);if(await readVersion(cached)===CAMPUS_GO_VERSION)return cached;throw Error('Existing Go cache is unconfirmed');}
    const folder=await mkdtemp(join(base,'download-'));
    try{
      const response=await fetchArchive('https://go.dev/dl/'+item.filename,{signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw Error('Official Go archive download failed');
      const declared=Number(response.headers.get('content-length'));if(declared>100*1024**2)throw Error('Go archive exceeds bound');
      const parts=[];let size=0;for await(const part of response.body){size+=part.length;if(size>100*1024**2)throw Error('Go archive exceeds bound');parts.push(part);}
      const bytes=Buffer.concat(parts);if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Official Go archive SHA mismatch');
      const archive=join(folder,item.filename);await writeFile(archive,bytes,{mode:0o600});await extractArchive('tar',[platform==='win32'?'-xf':'-xzf',archive,'-C',folder]);await rm(archive);
      const tool=binaryPath(folder,platform);if(await readVersion(tool)!==CAMPUS_GO_VERSION)throw Error('Extracted Go version mismatch');
      const binarySha256=createHash('sha256').update(await ordinaryBytes(tool,64*1024**2)).digest('hex');
      await writeFile(join(folder,'verified-source.json'),JSON.stringify({version:CAMPUS_GO_VERSION,...item,binarySha256,source:'https://go.dev/dl/?mode=json&include=all'})+'\n',{mode:0o600});
      try{await rename(folder,target);}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;await verifiedCached(target,item,platform);if(await readVersion(cached)!==CAMPUS_GO_VERSION)throw e;await rm(folder,{recursive:true,force:true});}
      return cached;
    }catch(e){await rm(folder,{recursive:true,force:true});throw e;}
  })();pending.set(target,work);try{return await work;}finally{pending.delete(target);}
}
