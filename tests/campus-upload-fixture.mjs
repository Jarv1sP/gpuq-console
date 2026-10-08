// Test-only stores keep their original validation and durable-write faults.
// These adapters give them distinct control and file endpoints. Production
// transports are exercised by direct-upload-client-integration.test.js.
import {createServer as createHTTPS} from 'node:https';
import {createHash,generateKeyPairSync,randomBytes,sign,X509Certificate} from 'node:crypto';
import {Readable} from 'node:stream';
import './campus-native-fixture-preload.mjs';
export const campusFixtureArgs=['--import',new URL('./campus-native-fixture-preload.mjs',import.meta.url).href];
const endpoint='https://campus.example.test',ticket='fixture-campus-ticket-only';
const transport={protocol:'dataset-upload-v1',directAvailable:true};
// Disposable RSA certificate, generated with Node's bundled crypto on every
// supported OS. Tests do not require a separately installed OpenSSL command.
export function testTLSIdentity(){
  const der=(tag,...values)=>{const body=Buffer.concat(values),hex=body.length.toString(16).padStart(body.length.toString(16).length+(body.length.toString(16).length%2),'0'),size=Buffer.from(hex,'hex');return Buffer.concat([Buffer.from([tag]),body.length<128?Buffer.from([body.length]):Buffer.concat([Buffer.from([0x80|size.length]),size]),body]);};
  const seq=(...values)=>der(0x30,...values),algorithm=seq(der(6,Buffer.from('2a864886f70d01010b','hex')),der(5,Buffer.alloc(0)));
  const name=seq(der(0x31,seq(der(6,Buffer.from('550403','hex')),der(12,Buffer.from('localhost')))));
  const utc=date=>der(23,Buffer.from(date.toISOString().slice(2,19).replace(/[-:T]/g,'')+'Z'));
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const serial=randomBytes(16);serial[0]=(serial[0]&0x7f)||1;
  const tbs=seq(der(0xa0,der(2,Buffer.from([2]))),der(2,serial),algorithm,name,seq(utc(new Date(Date.now()-86400000)),utc(new Date(Date.now()+86400000))),name,keys.publicKey.export({type:'spki',format:'der'}));
  const certificate=seq(tbs,algorithm,der(3,Buffer.concat([Buffer.from([0]),sign('sha256',tbs,keys.privateKey)])));
  const parsed=new X509Certificate(certificate);if(!parsed.verify(keys.publicKey))throw Error('Invalid disposable TLS certificate');
  return {key:keys.privateKey.export({type:'pkcs8',format:'pem'}),cert:parsed.toString(),pin:createHash('sha256').update(certificate).digest('hex')};
}
export function campusBrowserFixture(store,{machine='gpu-1'}={}){
  let initial;
  return {
    call:async(op,args)=>op==='datasets.upload.direct-ticket'?{available:true,protocol:'dataset-upload-v1',endpoint,ticket,expiresAt:Math.floor(Date.now()/1000)+300,certificateSha256:'a'.repeat(64),chunkBytes:1048576,kind:'campus-direct'}:
      op==='datasets.upload.begin'?{...(initial=await store(op,args)),uploadTransport:transport}:store(op,args),
    fetch:async(url,options)=>{
      const target=new URL(url);if(target.origin!==endpoint||options.headers.Authorization!==`Bearer ${ticket}`)throw Error('Fixture destination or ticket differs');
      const [,,,uploadId,action]=target.pathname.split('/');
      if(action==='status'&&!target.searchParams.has('path'))return Response.json({ok:true,result:initial});
      const args={machine,uploadId,...(target.searchParams.has('path')?{path:target.searchParams.get('path')}:{}),...(action!=='status'?{offset:Number(target.searchParams.get('offset')),data:Buffer.from(options.body).toString('base64')}:{})};
      return Response.json({ok:true,result:await store('datasets.upload.'+action,args)});
    }
  };
}
export function campusCoreFixture(store,{machine='gpu-1'}={}){return async(_grant,{uploadId})=>({chunkBytes:1048576,request:async(action,{bytes,...args})=>store('datasets.upload.'+action,{machine,uploadId,...args,...(bytes!==undefined?{data:bytes.toString('base64')}:{})}),close(){}});}
export async function campusTLSFixture(handler,{machine='gpu-1'}={}){
  const {key,cert,pin}=testTLSIdentity();
  let origin;const counters={portalFileRequests:0,rawBytes:0};
  const synthetic=(req,value)=>Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]),{socket:req.socket,headers:req.headers,url:req.url});
  const direct=createHTTPS({key,cert},async(req,res)=>{
    try{
      if(req.headers.authorization!==`Bearer ${ticket}`){res.writeHead(403);res.end();return;}
      const url=new URL(req.url,origin),[,,,uploadId,action]=url.pathname.split('/');
      if(!['manifest','chunk','status'].includes(action)||!uploadId){res.writeHead(400);res.end();return;}
      const parts=[];for await(const bytes of req)parts.push(bytes);const bytes=Buffer.concat(parts);counters.rawBytes+=bytes.length;
      const args={machine,uploadId,...(url.searchParams.has('path')?{path:url.searchParams.get('path')}:{}),...(action!=='status'?{offset:Number(url.searchParams.get('offset')),data:bytes.toString('base64')}:{})};
      const end=res.end.bind(res);res.end=body=>{if(res.statusCode===200){const value=JSON.parse(body);body=JSON.stringify({ok:true,result:value.result});}return end(body);};
      await handler(Object.assign(synthetic(req,{operation:'datasets.upload.'+action,args}),{url:'/api/call',campusDirect:true}),res);
    }catch{if(!res.writableEnded){res.statusCode=400;res.end('{"ok":false}');}}
  });
  await new Promise(resolve=>direct.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${direct.address().port}`;
  const grant=()=>({available:true,protocol:'dataset-upload-v1',endpoint:origin,ticket,expiresAt:Math.floor(Date.now()/1000)+300,certificateSha256:pin,chunkBytes:1048576,kind:'campus-direct',routeId:'primary',revision:'c'.repeat(64),machine});
  const control=async(req,res)=>{
    const parts=[];for await(const bytes of req)parts.push(bytes);const value=JSON.parse(Buffer.concat(parts));
    res.setHeader('Content-Type','application/json');
    if(['datasets.upload.manifest','datasets.upload.chunk'].includes(value.operation)){counters.portalFileRequests++;res.statusCode=400;res.end('{"error":"file bytes cannot use control"}');return;}
    if(value.operation==='datasets.upload.direct-ticket'){res.end(JSON.stringify({result:grant()}));return;}
    if(value.operation==='datasets.upload.begin'){
      const end=res.end.bind(res);res.end=body=>{if(res.statusCode===200){const reply=JSON.parse(body);reply.result.uploadTransport=transport;body=JSON.stringify(reply);}return end(body);};
    }
    return handler(synthetic(req,value),res);
  };
  return {control,counters,grant,close:async()=>{await new Promise(resolve=>direct.close(resolve));}};
}
