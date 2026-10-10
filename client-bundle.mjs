import {readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';

const PLACEHOLDER='__GPUQ_PUBLIC_ORIGIN__';
const CLIENT_FILE=new URL('./build/gpuctl.mjs',import.meta.url);
const unavailable=error=>error.code==='ENOENT'
  ?Object.assign(Error('Standalone client is not built; run npm run build:client before starting the portal.'),{status:503})
  :error;

// Byte replacement keeps binary payloads bounded even when a JSON literal
// crosses a read boundary. Readable.from supplies response backpressure and
// closes the underlying file iterator when a download is disconnected.
export function standaloneClientStream(origin=PLACEHOLDER,{file=CLIENT_FILE,chunkBytes=65536}={}){
  const literal=Buffer.from(JSON.stringify(PLACEHOLDER));
  const replacement=Buffer.from(JSON.stringify(origin));
  async function* rendered(){
    let tail=Buffer.alloc(0),found=false;
    try{
      for await(const chunk of createReadStream(file,{highWaterMark:chunkBytes})){
        const data=tail.length?Buffer.concat([tail,chunk]):chunk;
        let at=0,index;
        while((index=data.indexOf(literal,at))!==-1){
          found=true;
          if(index>at)yield data.subarray(at,index);
          yield replacement;
          at=index+literal.length;
        }
        const end=Math.max(at,data.length-literal.length+1);
        if(end>at)yield data.subarray(at,end);
        tail=data.subarray(end);
      }
      if(!found)throw Error('Built client is missing its public origin placeholder');
      if(tail.length)yield tail;
    }catch(error){throw unavailable(error);}
  }
  return Readable.from(rendered(),{objectMode:false,highWaterMark:65536});
}

export async function standaloneClientInfo(origin=PLACEHOLDER,options){
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of standaloneClientStream(origin,options)){hash.update(chunk);bytes+=chunk.length;}
  return {sha256:hash.digest('hex'),bytes};
}

// Offsets refer to the rendered, uncompressed artifact, including the origin
// replacement. Closing the range closes the underlying bounded file iterator.
export function standaloneClientRangeStream(origin,{start=0,end,...options}={}){
  async function* ranged(){
    let offset=0;
    for await(const chunk of standaloneClientStream(origin,options)){
      const next=offset+chunk.length;
      if(next>start){
        const from=Math.max(0,start-offset),to=end===undefined?chunk.length:Math.min(chunk.length,end-offset+1);
        if(to>from)yield chunk.subarray(from,to);
      }
      offset=next;
      if(end!==undefined&&offset>end)return;
    }
  }
  return Readable.from(ranged(),{objectMode:false,highWaterMark:65536});
}

export function clientByteRange(value,total){
  const match=/^bytes=(\d*)-(\d*)$/.exec(value||'');
  if(!match||!match[1]&&!match[2])return null;
  let start,end;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,total-suffix);end=total-1;}
  else {start=Number(match[1]);end=match[2]?Number(match[2]):total-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=total||end<start)return null;
  return {start,end:Math.min(end,total-1)};
}

export async function standaloneClient(origin=PLACEHOLDER){
  let source;
  try{source=await readFile(CLIENT_FILE,'utf8');}
  catch(error){throw unavailable(error);}
  const literal=JSON.stringify(PLACEHOLDER);
  if(!source.includes(literal))throw Error('Built client is missing its public origin placeholder');
  return source.replaceAll(literal,()=>JSON.stringify(origin));
}
