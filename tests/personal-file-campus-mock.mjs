import {createServer} from 'node:https';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID,X509Certificate} from 'node:crypto';

// Existing CLI fixtures retain their synthetic journal/job responses, but the
// byte leg now really uses a distinct local HTTPS server instead of /api/call.
export async function mockCampusFiles(t,handle,{allowedOrigins=[]}={}){
  const dir=await mkdtemp(join(tmpdir(),'mock-campus-files-')),key=join(dir,'key'),cert=join(dir,'cert');
  const built=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  if(built.status!==0)throw Error('Local test certificate generation failed');
  const certificate=await readFile(cert),grants=new Map();
  const pin=createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex');
  const server=createServer({key:await readFile(key),cert:certificate},async(req,res)=>{
    try{
      const origin=req.headers.origin;
      if(origin){if(!allowedOrigins.includes(origin))throw Error('Invalid test origin');res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Expose-Headers','X-GPUQ-File-Metadata');res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Authorization, Content-Type'});res.end();return;}
      const url=new URL(req.url,'https://localhost'),entry=grants.get(req.headers.authorization?.slice(7));
      if(!entry||url.pathname!==`/v1/files/${entry.grant.grantId}/${entry.args.action}`)throw Error('Invalid test grant');
      const {action,...scope}=entry.args,offset=Number(url.searchParams.get('offset'));
      let result;
      if(action==='put'){
        const parts=[];for await(const bytes of req)parts.push(bytes);const bytes=Buffer.concat(parts);if(bytes.length>1048576)throw Error('Oversized test chunk');
        result=await handle('files.put',{...scope,offset,final:url.searchParams.get('final')==='true',data:bytes.toString('base64')});
        const body=Buffer.from(JSON.stringify({ok:true,result}));res.writeHead(200,{'Content-Type':'application/json','Content-Length':body.length});res.end(body);
      }else{
        result=await handle('files.get',{...scope,offset,fingerprint:entry.grant.file.fingerprint});
        const bytes=Buffer.from(result.data,'base64');const {data,...metadata}=result;
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,'X-GPUQ-File-Metadata':Buffer.from(JSON.stringify({...metadata,protocol:2,fingerprint:entry.grant.file.fingerprint})).toString('base64url')});res.end(bytes);
      }
    }catch(error){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return {
    endpoint:`https://127.0.0.1:${server.address().port}`,spki:createHash('sha256').update(new X509Certificate(certificate).publicKey.export({type:'spki',format:'der'})).digest('base64'),
    async ticket(args){
      const file=args.action==='get'?await handle('files.get',{...args,offset:0}):{};
      const grant={available:true,protocol:'personal-file-campus-v1',machine:args.machine,kind:'campus-direct',routeId:'primary',endpoint:`https://127.0.0.1:${server.address().port}`,certificateSha256:pin,revision:'c'.repeat(64),grantId:randomUUID(),expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:1048576,ticket:randomUUID()+randomUUID(),file:{path:args.path,protocol:2,fingerprint:createHash('sha256').update(JSON.stringify([args.machine,args.project,args.area,args.runId,args.path,file.size])).digest('hex'),size:file.size}};
      grants.set(grant.ticket,{grant,args});return grant;
    }
  };
}
