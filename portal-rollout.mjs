import http from 'node:http';
import {spawn} from 'node:child_process';
import {chmod,unlink,mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Keep one owner of Portal's in-memory state/SQLite database. A prewarmed
// candidate forwards to the old owner, then holds new requests during handoff.
// A request already forwarded is never retried or replayed by this supervisor.
export function createRolloutServer({upstream,startActive,queueTimeout=90000,maxPending=64}){
  let phase='proxy',target=new URL(upstream),forwarding=0,activation;
  const pending=new Set();
  const forward=(req,res)=>{
    if(req.destroyed||res.destroyed)return;
    forwarding++;
    const next=http.request({hostname:target.hostname,port:target.port||80,method:req.method,path:req.url,headers:req.headers,agent:false},reply=>{
      res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);
      reply.on('error',()=>res.destroy());
    });
    let ended=false;
    const finish=()=>{if(!ended){ended=true;forwarding--;}};
    res.once('close',()=>{finish();next.destroy();});
    next.once('error',()=>{
      finish();
      if(res.headersSent)return res.destroy();
      res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({error:'服务连接中断；原操作未自动重试，请查询原编号。'}));
    });
    req.once('aborted',()=>next.destroy());req.pipe(next);
  };
  const server=http.createServer((req,res)=>{
    if(req.url==='/healthz'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({ok:true,phase,forwarding,pending:pending.size}));
    }
    if(phase!=='hold'&&phase!=='activating')return forward(req,res);
    if(pending.size>=maxPending){res.writeHead(503,{'Retry-After':'1','Cache-Control':'no-store'});return res.end();}
    const entry={req,res};pending.add(entry);
    const remove=()=>{pending.delete(entry);clearTimeout(entry.timer);};
    entry.timer=setTimeout(()=>{remove();if(!res.destroyed){res.writeHead(503,{'Retry-After':'1','Cache-Control':'no-store'});res.end();}},queueTimeout);
    res.once('close',remove);
  });
  server.headersTimeout=10000;server.requestTimeout=120000;server.keepAliveTimeout=5000;server.maxConnections=128;
  return {server,state:()=>({phase,forwarding,pending:pending.size}),
    hold(){if(phase!=='proxy')throw Error('Handoff is not in proxy phase');phase='hold';},
    activate(){
      if(phase==='active')return Promise.resolve();
      if(activation)return activation;
      if(phase!=='hold'||forwarding!==0)return Promise.reject(Error('Old requests have not drained'));
      phase='activating';
      activation=Promise.resolve().then(startActive).then(url=>{
        target=new URL(url);phase='active';
        for(const entry of [...pending]){clearTimeout(entry.timer);pending.delete(entry);forward(entry.req,entry.res);}
      },error=>{phase='hold';activation=null;throw error;});
      return activation;
    },
    close(){for(const entry of pending){clearTimeout(entry.timer);entry.res.destroy();}pending.clear();return new Promise(resolve=>server.close(resolve));}
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.umask(0o077);
  // Import/validate candidate code without opening the shared production DB.
  await import('./portal-server.mjs');
  const {parseHostRootAllowlist}=await import('./host-root-policy.mjs');
  parseHostRootAllowlist(process.env.GPUQ_HOST_ROOT_ALLOWLIST||'[]');
  const upstream=process.argv[2],generation=process.argv[3];
  if(!upstream||! /^[a-f0-9]{7,40}$/.test(generation||''))throw Error('Old Portal upstream and release generation are required');
  const markerDir='/data/portal-rollout',marker=markerDir+'/active',childPort=8081,controlPath='/tmp/portal-rollout-control.sock';let child,stopping=false;
  const rollout=createRolloutServer({upstream,startActive:async()=>{
    await mkdir(markerDir,{recursive:true,mode:0o700});
    const tmp=marker+'.'+process.pid;await writeFile(tmp,generation,{mode:0o600,flag:'wx'});await rename(tmp,marker);
    child=spawn(process.execPath,['portal-server.mjs'],{stdio:'inherit',env:{...process.env,PORT:String(childPort),LISTEN_HOST:'127.0.0.1'}});
    let exited=false;child.once('exit',code=>{exited=true;if(rollout.state().phase==='active'&&!stopping)process.exit(code||1);});
    for(let i=0;i<150;i++){
      if(exited)throw Error('Candidate Portal exited before readiness');
      const ok=await new Promise(resolve=>{
        const req=http.get({hostname:'127.0.0.1',port:childPort,path:'/healthz',headers:{Host:new URL(process.env.PUBLIC_ORIGIN).host}},res=>{res.resume();resolve(res.statusCode===200);});
        req.setTimeout(500,()=>req.destroy());req.on('error',()=>resolve(false));
      });
      if(ok)return 'http://127.0.0.1:'+childPort;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Candidate Portal readiness timeout');
  }});
  const control=http.createServer(async(req,res)=>{
    try{
      if(req.method==='POST'&&req.url==='/hold')rollout.hold();
      else if(req.method==='POST'&&req.url==='/activate')await rollout.activate();
      else if(req.method!=='GET'||req.url!=='/state'){res.writeHead(404);return res.end();}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rollout.state()));
    }catch(error){res.writeHead(409);res.end(JSON.stringify({error:error.message}));}
  });
  await unlink(controlPath).catch(error=>{if(error.code!=='ENOENT')throw error;});
  await new Promise(resolve=>control.listen(controlPath,resolve));await chmod(controlPath,0o600);
  let previous;try{previous=await readFile(marker,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous===generation){rollout.hold();await rollout.activate();}
  rollout.server.listen(Number(process.env.PORT||8080),process.env.LISTEN_HOST||'0.0.0.0');
  const stop=()=>{
    if(stopping)return;stopping=true;
    if(child){child.once('exit',()=>{control.close();rollout.close().then(()=>process.exit(0));});child.kill('SIGTERM');}
    else{control.close();rollout.close().then(()=>process.exit(0));}
  };
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
}
