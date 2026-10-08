// Test-only native frame peer for the existing real HTTPS loopback fixtures.
// Never bundled, exported, or selected by a production environment variable.
import {pinnedUploadAgent,directUploadRequest} from '../client-direct-upload.mjs';
import {personalFileGrant,personalFileRequest} from '../client-personal-file-campus.mjs';

let buffer=Buffer.alloc(0),agent,fixed,stopped=false,sequence=0;
const limit=1024**2,headerLimit=16384;
function reply(value,raw=Buffer.alloc(0)){
  const header=Buffer.from(JSON.stringify({schema:1,bodyBytes:raw.length,...value}));
  const size=Buffer.alloc(4);size.writeUInt32BE(header.length);
  process.stdout.write(Buffer.concat([size,header,raw]));
}
async function frame(value,bytes){
  if(value.schema!==1||!Number.isSafeInteger(value.seq)||value.seq<=sequence||value.bodyBytes!==bytes.length)throw Error('Invalid fixture frame');
  sequence=value.seq;
  if(stopped){reply({seq:sequence,ok:false,code:'SESSION_STOPPED'});return;}
  try{
    const g=value.grant,u=new URL(g.endpoint);
    if(u.protocol!=='https:'||u.hostname!=='127.0.0.1'||u.origin!==g.endpoint)throw Error('Fixture may only dial its local HTTPS server');
    const identity=JSON.stringify([g.endpoint,g.certificateSha256,g.machine,g.revision,g.protocol,value.uploadId,g.file?.path,g.file?.fingerprint]);
    if(fixed&&fixed!==identity)throw Error('Fixture grant identity changed');fixed=identity;
    agent??=pinnedUploadAgent(g.certificateSha256);
    let result;
    if(['get','put'].includes(value.op)){
      personalFileGrant(g,g.file.path,value.op);
      result=await personalFileRequest(g,agent,value.op,{offset:value.offset,...(value.op==='put'?{final:value.final,bytes}:{})});
    }else{
      result=await directUploadRequest(g,agent,{uploadId:value.uploadId,action:value.op,...(value.path!==undefined?{path:value.path}:{}),...(value.op!=='status'?{offset:value.offset,bytes}:{})});
    }
    if(value.op==='get'){const {data,...metadata}=result;reply({seq:sequence,ok:true,metadata},Buffer.from(data,'base64'));}
    else reply({seq:sequence,ok:true,result});
  }catch{
    stopped=true;agent?.destroy();reply({seq:sequence,ok:false,code:'FIXTURE_HTTPS_REJECTED',writeMayHaveReachedPeer:['put','manifest','chunk'].includes(value.op)});
  }
}
try{
  for await(const part of process.stdin){
    buffer=Buffer.concat([buffer,part]);
    while(buffer.length>=4){
      const size=buffer.readUInt32BE(0);if(size<1||size>headerLimit)throw Error('Invalid fixture header');
      if(buffer.length<4+size)break;
      const header=JSON.parse(buffer.subarray(4,4+size));
      if(!Number.isSafeInteger(header.bodyBytes)||header.bodyBytes<0||header.bodyBytes>limit)throw Error('Invalid fixture body');
      const end=4+size+header.bodyBytes;if(buffer.length<end)break;
      const body=buffer.subarray(4+size,end);buffer=buffer.subarray(end);await frame(header,body);
    }
  }
}finally{agent?.destroy();}
