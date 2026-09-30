// Incremental SHA256 and the bounded HTTPS dataset upload protocol. No remote dependencies.
export const CHUNK_BYTES=1024*1024,MAX_MANIFEST_BYTES=64*1024*1024,MAX_ENTRIES=500000;
const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rr=(n,b)=>(n>>>b)|(n<<(32-b));
export class SHA256{
  constructor(){this.h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);this.buffer=new Uint8Array(64);this.words=new Uint32Array(64);this.used=0;this.bytes=0;this.finished=false;}
  block(data,start){
    const w=this.words;for(let i=0;i<16;i++){const p=start+i*4;w[i]=(data[p]<<24)|(data[p+1]<<16)|(data[p+2]<<8)|data[p+3];}
    for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(rr(a,7)^rr(a,18)^(a>>>3))+w[i-7]+(rr(b,17)^rr(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,h]=this.h;
    for(let i=0;i<64;i++){const t=(h+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0,u=((rr(a,2)^rr(a,13)^rr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t)>>>0;d=c;c=b;b=a;a=(t+u)>>>0;}
    const out=[a,b,c,d,e,f,g,h];for(let i=0;i<8;i++)this.h[i]=(this.h[i]+out[i])>>>0;
  }
  update(data){
    if(this.finished)throw Error('SHA256 is already finalized');if(!(data instanceof Uint8Array))throw Error('SHA256 requires bytes');
    this.bytes+=data.length;if(!Number.isSafeInteger(this.bytes))throw Error('File size exceeds safe integer range');let at=0;
    if(this.used){const n=Math.min(64-this.used,data.length);this.buffer.set(data.subarray(0,n),this.used);this.used+=n;at+=n;if(this.used===64){this.block(this.buffer,0);this.used=0;}}
    for(;at+64<=data.length;at+=64)this.block(data,at);
    if(at<data.length){this.buffer.set(data.subarray(at),0);this.used=data.length-at;}return this;
  }
  hex(){
    if(!this.finished){const bytes=this.bytes;this.buffer[this.used++]=0x80;if(this.used>56){this.buffer.fill(0,this.used);this.block(this.buffer,0);this.used=0;}this.buffer.fill(0,this.used,56);const view=new DataView(this.buffer.buffer);view.setUint32(56,Math.floor(bytes/0x20000000));view.setUint32(60,(bytes*8)>>>0);this.block(this.buffer,0);this.finished=true;}
    return [...this.h].map(n=>n.toString(16).padStart(8,'0')).join('');
  }
}
const textBytes=value=>new TextEncoder().encode(value);
export function uploadKey(userId,machine,name,manifestSha256){const h=new SHA256().update(textBytes(JSON.stringify([userId,machine,name,manifestSha256]))).hex();return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
export function datasetPath(path){if(typeof path!=='string'||!path||textBytes(path).length>4096||path.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(p=>['','.','..','.ssh','.env','.git','.venv','anaconda3','miniconda3','.conda'].includes(p)))throw Error('目录包含不支持的路径、凭据或环境目录：'+path);return path;}
const alive=signal=>{if(signal?.aborted)throw Error('上传已暂停；选择同一目录可继续。');};
export async function hashBlob(blob,{signal,onProgress=()=>{}}={}){const hash=new SHA256();for(let at=0;at<blob.size;at+=CHUNK_BYTES){alive(signal);const chunk=new Uint8Array(await blob.slice(at,at+CHUNK_BYTES).arrayBuffer());alive(signal);if(chunk.length!==Math.min(CHUNK_BYTES,blob.size-at))throw Error('本地文件读取不完整；请重新选择目录。');hash.update(chunk);onProgress(Math.min(at+chunk.length,blob.size));}return hash.hex();}
export function manifestBlob(directories,files){
  if(directories.length+files.length>MAX_ENTRIES)throw Error('清单最多包含 500,000 个文件和目录。');
  const parts=['{"schema":1,"directories":['];let bytes=parts[0].length;
  const add=value=>{bytes+=textBytes(value).length;if(bytes>MAX_MANIFEST_BYTES)throw Error('清单超过 64 MiB，请按数据范围拆分。');parts.push(value);};
  directories.forEach((path,i)=>add((i?',':'')+JSON.stringify(path)));add('],"files":[');files.forEach((file,i)=>add((i?',':'')+JSON.stringify(file)));add(']}');return new Blob(parts,{type:'application/json'});
}
export async function scanBrowserDirectory(selection,{signal,onProgress=()=>{}}={}){
  const input=Array.from(selection);if(!input.length)throw Error('请先选择包含文件的目录。');
  const paths=new Map(),dirs=new Set();let totalBytes=0,hashed=0;
  for(const file of input){const relative=datasetPath(file.webkitRelativePath||file.name),path=datasetPath(relative.includes('/')?relative.slice(relative.indexOf('/')+1):relative);if(paths.has(path))throw Error('目录包含重复文件路径：'+path);paths.set(path,file);const bits=path.split('/');for(let i=1;i<bits.length;i++)dirs.add(bits.slice(0,i).join('/'));totalBytes+=file.size;if(!Number.isSafeInteger(totalBytes))throw Error('数据总量过大。');if(paths.size+dirs.size>MAX_ENTRIES)throw Error('清单最多包含 500,000 个文件和目录。');}
  const files=[];for(const path of [...paths.keys()].sort()){alive(signal);const file=paths.get(path),sha256=await hashBlob(file,{signal,onProgress:bytes=>onProgress({state:'HASHING',bytes:hashed+bytes,totalBytes,path})});files.push({path,size:file.size,sha256});hashed+=file.size;onProgress({state:'HASHING',bytes:hashed,totalBytes,path});}
  const manifest=manifestBlob([...dirs].sort(),files),manifestSha256=await hashBlob(manifest,{signal});return {files,paths,manifest,manifestSha256,totalBytes,entries:files.length+dirs.size};
}
function base64(data){let value='';for(let i=0;i<data.length;i+=8192)value+=String.fromCharCode(...data.subarray(i,i+8192));return btoa(value);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function uploadBrowserDataset({call,userId,machine,name,scan,signal,onProgress=()=>{},pollMs=1500,keyStore}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name))throw Error('名称需为 1–40 位字母、数字、下划线或连字符。');
  let uploadId,state;
  const request=async(action,args={})=>{alive(signal);const result=await call('datasets.upload.'+action,{machine,...(uploadId&&action!=='begin'?{uploadId}:{}),...args});alive(signal);return result;};
  const report=(current,extra={})=>{state=current;onProgress({...current,...extra});};
  const ready=()=>{if(state.state!=='READY'||!state.dataset||!/^[a-f0-9]{64}$/.test(state.version||''))throw Error('服务器尚未确认数据集完整就绪。');return state;};
  const waitFor=async()=>{while(['SEALING','PUBLISHING'].includes(state.state)){alive(signal);await pause(pollMs);report(await request('status'));}if(state.state==='FAILED')throw Error(state.error||'服务端校验失败；修复后重新上传同一目录。');if(state.state==='DISCARDED')throw Error('这次上传已取消。');};
  const baseKey=uploadKey(userId,machine,name,scan.manifestSha256),begin={name,key:keyStore?.get(baseKey)||baseKey,manifestBytes:scan.manifest.size,manifestSha256:scan.manifestSha256,totalBytes:scan.totalBytes,entries:scan.entries};
  report(await request('begin',begin));
  if(state.state==='DISCARDED'){
    if(!keyStore)throw Error('这次上传已取消；请使用能保存续传信息的客户端重新开始。');
    begin.key=crypto.randomUUID();keyStore.set(baseKey,begin.key);report(await request('begin',begin));
  }
  uploadId=state.uploadId;if(typeof uploadId!=='string'||!uploadId)throw Error('服务器未返回上传编号。');
  if(state.state==='FAILED'&&state.resumeState==='SEALING')report(await request('seal'));
  if(state.state==='FAILED'&&state.resumeState==='PUBLISHING')report(await request('commit'));
  if(state.state==='FAILED'&&['RECEIVING_MANIFEST','UPLOADING'].includes(state.resumeState))state={...state,state:state.resumeState};
  if(state.state==='RECEIVING_MANIFEST'){
    let offset=state.manifestOffset;if(!Number.isSafeInteger(offset)||offset<0||offset>scan.manifest.size)throw Error('服务器清单偏移无效。');
    while(offset<scan.manifest.size){const bytes=new Uint8Array(await scan.manifest.slice(offset,offset+CHUNK_BYTES).arrayBuffer());if(bytes.length!==Math.min(CHUNK_BYTES,scan.manifest.size-offset))throw Error('清单读取不完整。');const result=await request('manifest',{offset,data:base64(bytes)});if(result.offset!==offset+bytes.length)throw Error('服务器未确认清单分块。');offset=result.offset;report({...state,manifestOffset:offset});}
    report(await request('seal'));
  }
  await waitFor();if(state.state==='READY')return ready();
  if(state.state!=='UPLOADING')throw Error('服务器上传状态未确认，请重新选择同一目录续传。');
  let transferred=0;
  for(const entry of scan.files){
    const status=await request('status',{path:entry.path}),remote=status.file;
    if(!remote||remote.path!==entry.path||remote.size!==entry.size||remote.sha256!==entry.sha256||!Number.isSafeInteger(remote.offset)||remote.offset<0||remote.offset>entry.size)throw Error('服务器文件续传信息不匹配。');
    const file=scan.paths.get(entry.path),hash=new SHA256();let sent=remote.offset;
    for(let at=0;at<file.size;at+=CHUNK_BYTES){alive(signal);const bytes=new Uint8Array(await file.slice(at,at+CHUNK_BYTES).arrayBuffer());if(bytes.length!==Math.min(CHUNK_BYTES,file.size-at))throw Error('本地文件读取不完整；未发布。');hash.update(bytes);const begin=Math.max(0,sent-at);if(begin<bytes.length){const part=bytes.subarray(begin),result=await request('chunk',{path:entry.path,offset:sent,data:base64(part)});if(result.offset!==sent+part.length)throw Error('服务器未确认文件分块。');sent=result.offset;}report({...state,state:'UPLOADING'},{path:entry.path,bytes:transferred+sent,totalBytes:scan.totalBytes});}
    if(!file.size&&!remote.complete){const result=await request('chunk',{path:entry.path,offset:0,data:''});if(result.offset!==0||result.complete!==true)throw Error('服务器未确认空文件。');}
    if(hash.hex()!==entry.sha256)throw Error('本地文件在上传时发生变化；未发布，请重新选择目录。');
    transferred+=entry.size;report({...state,state:'UPLOADING'},{bytes:transferred,totalBytes:scan.totalBytes});
  }
  report(await request('commit'));await waitFor();return ready();
}
