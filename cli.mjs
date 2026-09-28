#!/usr/bin/env node
import {readFile,mkdir,writeFile,chmod,unlink,open,lstat,readdir} from 'node:fs/promises';
import {dirname,join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {createInterface} from 'node:readline/promises';

const help=`GPUQ — 个人终端与 GPUQ 训练

日常命令（一次安装后直接使用 gpuctl）：
gpuctl login                     Sign in; remembers your account and service
gpuctl use gpu-1                  Select an approved server from your inventory
gpuctl ssh                       Interactive private workspace terminal
gpuctl ssh --root                Administrator: unrestricted host root terminal
gpuctl push .                    Upload current directory into /workspace
gpuctl run -g 2 -- python train.py
gpuctl jobs / logs JOB / cancel JOB
gpuctl pull results/model.pt ./model.pt

gpuctl login USERNAME              Login (hidden password prompt)
gpuctl register USERNAME           Register with invite + own password
gpuctl invites list                Administrator: invitation metadata only
gpuctl invites rotate member       Generate member code (old code revoked)
gpuctl invites disable member
gpuctl logout                      Invalidate current session
gpuctl users                       List visible accounts / quotas
gpuctl state                       View machines, accounts and jobs
gpuctl user add USERNAME           Create account; initially no access
                                         Optional: --role admin (full access)
gpuctl user reset-password USERNAME
gpuctl user enable|disable USERNAME
gpuctl user delete USERNAME       Only disabled accounts without active jobs
gpuctl user role USERNAME admin|member
gpuctl grant USERNAME --machine gpu-1=2 --total 2
gpuctl grant USERNAME --full       All GPU resources; NOT platform admin
gpuctl run auto --cards 2 --min-vram 24 -- python -m torch.distributed.run --standalone --nproc-per-node=2 train.py
gpuctl run gpu-1 --cards 1 --name train -- python train.py
gpuctl jobs
gpuctl logs JOB_ID
gpuctl cancel JOB_ID
gpuctl upload gpu-1 LOCAL_PATH [REMOTE_PATH]
gpuctl files gpu-1 [REMOTE_DIRECTORY]
gpuctl download gpu-1 REMOTE_FILE LOCAL_FILE
gpuctl request gpu-1 --cards 1  Member uses their own identity
gpuctl release DEMO-001

--machine may repeat; grant REPLACES the entire machine policy.
No --machine and --total 0 revokes all future GPU access.
Global: --url http://127.0.0.1:58418 --json --session-file PATH
Credentials: --password-stdin (one password via stdin, never an argument)
Registration: --credentials-stdin accepts JSON {"invite":"...","password":"..."}
Administrator: all machines as self; --as is only for the separate demo
Default session cache: ~/.config/gpuq-console/session.json (mode 0600).
GPUQ_URL / GPUQ_SESSION_FILE configure the service and cache.
Existing legacy caches and AMAX_URL / AMAX_SESSION_FILE remain supported.
Only loopback HTTP or HTTPS URLs accepted. The VPS portal has a shared API;
the separate hosted static preview does not. request/release are demo-only.
run executes on the selected server, in your private /workspace. Upload code first.
--key UUID allows safe submission retry. No --as impersonation for real jobs.
The standard Python environment is /opt/conda; pip: python -m pip install --user ...`;
const args=process.argv.slice(2),positionals=[],options={machines:[]};let training=[];
let wantsJSON=args.slice(0,args.includes('--')?args.indexOf('--'):args.length).includes('--json');
function fail(message){throw Error(message);}
async function secret(label='Password'){
  if(options['password-stdin']){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>1024)fail('Password input too long');}return value.replace(/\r?\n$/,'');}
  if(!process.stdin.isTTY)fail('Use --password-stdin for non-interactive password input.');
  process.stderr.write(`${label}: `);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';const finish=(error)=>{process.stdin.off('data',listener);process.stdin.setRawMode(false);process.stdin.pause();process.stderr.write('\n');error?reject(error):resolve(value);};
    const listener=chunk=>{for(const char of chunk.toString()){if(char==='\u0003')return finish(Error('Cancelled'));if(char==='\r'||char==='\n')return finish();if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char>=' ')value+=char;if(value.length>128)return finish(Error('Password too long'));}};
    process.stdin.on('data',listener);
  });
}
async function main(){
  for(let i=0;i<args.length;i++){
    if(args[i]==='--'){training=args.slice(i+1);break;}
    const item=args[i]==='-g'?'--cards':args[i];if(!item.startsWith('--')){positionals.push(item);continue;}
    const key=item.slice(2);
    if(['json','password-stdin','credentials-stdin','help','full','root'].includes(key)){options[key]=true;continue;}
    if(!['url','session-file','machine','total','cards','as','role','name','min-vram','key'].includes(key))fail(`Unknown option: ${item}`);
    const value=args[++i];if(!value||value.startsWith('--'))fail(`Missing value: ${item}`);
    if(key==='machine')options.machines.push(value);else options[key]=value;
  }
  if(options.help||!positionals.length){console.log(help);return;}
  const explicitSession=options['session-file']||process.env.GPUQ_SESSION_FILE||process.env.AMAX_SESSION_FILE;
  let sessionFile=explicitSession||join(homedir(),'.config','gpuq-console','session.json');
  // Keep one cache: a previous installation continues using its existing file.
  if(!explicitSession){try{await lstat(sessionFile);}catch(e){if(e.code!=='ENOENT')throw e;const legacy=join(homedir(),'.config','amax-demo','session.json');try{await lstat(legacy);sessionFile=legacy;}catch(old){if(old.code!=='ENOENT')throw old;}}}
  let session;try{session=JSON.parse(await readFile(sessionFile,'utf8'));}catch(e){if(e.code!=='ENOENT')fail('Unable to read session cache.');}
  const bundled='__GPUQ_PUBLIC_ORIGIN__';
  const target=options.url||process.env.GPUQ_URL||process.env.AMAX_URL||(bundled.startsWith('https://')?bundled:session?.url);
  if(!target)fail('首次运行源码客户端请指定 --url https://你的服务域名，或从门户安装客户端。');
  const base=new URL(target);
  if(base.username||base.password||base.pathname!=='/'||base.search||base.hash)fail('Use a base URL without credentials, path or query.');
  if(base.protocol!=='https:'&&!(base.protocol==='http:'&&base.hostname==='127.0.0.1'))fail('Remote APIs require HTTPS.');
  if(session&&session.url!==base.origin)session=undefined;
  async function post(path,body){
    const response=await fetch(new URL(`/api/${path}`,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(40000),headers:{'Content-Type':'application/json',...(session?{Authorization:`Bearer ${session.token}`}:{})},body:JSON.stringify(body)});
    let data;try{data=await response.json();}catch{fail('Target is not an GPUQ JSON API. The hosted static preview does not provide one.');}
    if(!response.ok)fail(data.error||`HTTP ${response.status}`);return data;
  }
  const call=(operation,args={})=>post('call',{operation,args});
  let command=positionals[0];let result,mode={demo:true,gpuqConnected:false};
  if(command==='register'){
    if(positionals.length!==2)fail('Usage: register USERNAME');
    if(options['password-stdin'])fail('Use --credentials-stdin with JSON {invite,password} for registration.');
    let credentials;
    if(options['credentials-stdin']){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>1024)fail('Registration input too long');}try{credentials=JSON.parse(value);}catch{fail('Expected JSON {invite,password} on stdin');}if(!credentials||typeof credentials!=='object'||Array.isArray(credentials)||Object.keys(credentials).some(key=>!['invite','password'].includes(key)))fail('Expected only invite and password');}
    else credentials={invite:await secret('Invite code'),password:await secret()};
    result=await post('register',{username:positionals[1],...credentials});mode={demo:false,gpuqConnected:false};
  }else if(command==='login'){
    if(positionals.length===1&&process.stdin.isTTY){const rl=createInterface({input:process.stdin,output:process.stdout});positionals.push(await rl.question('用户名: '));rl.close();}
    if(positionals.length!==2)fail('Usage: login USERNAME');
    const login=await post('login',{username:positionals[1],password:await secret()});
    mode={demo:login.state.demo,gpuqConnected:login.state.gpuqConnected===true};
    await mkdir(dirname(sessionFile),{recursive:true,mode:0o700});
    await writeFile(sessionFile,JSON.stringify({url:base.origin,token:login.token,principal:login.principal,...(session?.principal.userId===login.principal.userId&&session.machine?{machine:session.machine}:{})}),{mode:0o600});await chmod(sessionFile,0o600);
    result={loggedIn:true,principal:login.principal};
  }else{
    if(!session)fail('请先登录：gpuctl login');
    const state=(await call('state')).state;
    const machineName=value=>{const exact=state.machines.find(m=>m.id===value);if(exact)return exact.id;const short=state.machines.filter(m=>m.id.endsWith('-'+value));return short.length===1?short[0].id:value;};
    const defaultMachine=()=>session.machine||(state.machines?.length===1?state.machines[0].id:null)||fail('先选择一次服务器：gpuctl use gpu-1');
    const shortcut=command;
    if(command==='ssh')command='shell';if(command==='push')command='upload';if(command==='pull')command='download';
    if(['run','shell'].includes(command)&&positionals.length===1)positionals.push(defaultMachine());
    if(['push','pull'].includes(shortcut))positionals.splice(1,0,defaultMachine());
    if(shortcut==='push'&&positionals.length===3&&(await lstat(positionals[2])).isDirectory())positionals.push('.');
    if(['run','shell','upload','download','files','use'].includes(command)&&positionals[1])positionals[1]=machineName(positionals[1]);
    mode={demo:state.demo,gpuqConnected:state.gpuqConnected===true};
    const find=username=>{const user=state.users.find(u=>u.username===username);if(!user)fail('Unknown or unauthorized username');return user.id;};
    const own=()=>session.principal.role==='admin'&&options.as?find(options.as):session.principal.userId;
    if(command==='use'&&positionals.length===2){
      if(!state.machines.some(m=>m.id===positionals[1]))fail('这台机器未授权或不存在');session.machine=positionals[1];await writeFile(sessionFile,JSON.stringify(session),{mode:0o600});result={selected:session.machine};
    }else if(command==='shell'&&positionals.length===2){
      if(!process.stdin.isTTY)fail('交互终端需要 TTY；非交互任务使用 gpuctl run');
      const machine=positionals[1],hostAdmin=options.root===true;
      const opened=(await call('terminal.open',{machine,key:randomUUID(),hostAdmin})).result;
      let input=Buffer.alloc(0),offset=0,done=false,delay=250,lastSize='';
      const sessionArgs={machine,id:opened.id,hostAdmin};
      process.stderr.write(`\r\n${machine} · ${hostAdmin?'ROOT 宿主机':'个人工作区'}（Ctrl+] 断开；exit 结束）\r\n`);
      process.stdin.setRawMode(true);process.stdin.resume();
      const listener=chunk=>{if(chunk.includes(29)){done=true;return;}input=Buffer.concat([input,chunk]);if(input.length>262144)process.stdin.pause();};process.stdin.on('data',listener);
      try{while(!done){const sent=input.subarray(0,8192);input=input.subarray(sent.length);if(input.length<131072)process.stdin.resume();const size={cols:process.stdout.columns||110,rows:process.stdout.rows||32},sizeKey=JSON.stringify(size);const response=(await call('terminal.exchange',{...sessionArgs,offset,input:sent.toString('base64'),...(sizeKey===lastSize?{}:size)})).result;lastSize=sizeKey;offset=response.offset;if(response.data)process.stdout.write(Buffer.from(response.data,'base64'));if(response.exited){await call('terminal.close',sessionArgs);break;}await new Promise(r=>setTimeout(r,delay));}}
      finally{process.stdin.off('data',listener);process.stdin.setRawMode(false);process.stdin.pause();process.stderr.write('\r\n终端已断开。\r\n');}return;
    }else if(command==='invites'&&positionals[1]==='list'&&positionals.length===2)result=(await call('invites.list')).result;
    else if(command==='invites'&&['rotate','disable'].includes(positionals[1])&&['admin','member'].includes(positionals[2])&&positionals.length===3)result=(await call(`invites.${positionals[1]}`,{role:positionals[2]})).result;
    else if(command==='users'&&positionals.length===1)result=state.users;
    else if(command==='state'&&positionals.length===1)result=state;
    else if(command==='logout'&&positionals.length===1){result=(await call('logout')).result;await unlink(sessionFile).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    else if(command==='user'&&positionals[1]==='role'&&positionals.length===4)result=(await call('users.role',{userId:find(positionals[2]),role:positionals[3]})).result;
    else if(command==='user'&&positionals.length===3){
      const [_,action,username]=positionals;
      if(action==='add')result=(await call('users.create',{username,password:await secret(),role:options.role||'member'})).result;
      else if(action==='reset-password')result=(await call('users.reset',{userId:find(username),password:await secret()})).result;
      else if(action==='enable'||action==='disable')result=(await call('users.enabled',{userId:find(username),enabled:action==='enable'})).result;
      else if(action==='delete')result=(await call('users.delete',{userId:find(username)})).result;
      else fail('Unknown user command');
    }else if(command==='run'&&positionals.length===2){
      if(options.as)fail('--as cannot be used for real execution');
      if(!training.length)fail('Put the training command after --');
      const key=options.key||randomUUID();process.stderr.write(`Submission key: ${key}\n`);
      result=(await call('jobs.submit',{machine:positionals[1],cards:Number(options.cards||1),minVramGiB:Number(options['min-vram']||0),name:options.name||'train',argv:training,key})).result;
    }else if(command==='jobs'&&positionals.length===1)result=state.jobs;
    else if(['logs','cancel'].includes(command)&&positionals.length===2)result=(await call(command==='logs'?'jobs.logs':'jobs.cancel',{jobId:positionals[1]})).result;
    else if(command==='files'&&positionals.length<=3)result=(await call('files.list',{machine:positionals[1],path:positionals[2]||'.'})).result;
    else if(command==='upload'&&positionals.length>=3&&positionals.length<=4){
      const machine=positionals[1];let count=0;
      async function upload(local,path){
        const st=await lstat(local);if(st.isSymbolicLink())fail('Symlink upload is not supported');
        if(st.isDirectory()){for(const name of await readdir(local))await upload(join(local,name),path==='.'?name:`${path}/${name}`);return;}
        if(!st.isFile())fail('Only regular files/directories can be uploaded');
        const file=await open(local,'r');let offset=0;
        try{do{const buffer=Buffer.alloc(1024*1024);const {bytesRead}=await file.read(buffer,0,buffer.length,offset);await call('files.put',{machine,path,offset,truncate:offset===0,data:buffer.subarray(0,bytesRead).toString('base64')});offset+=bytesRead;}while(offset<st.size);}finally{await file.close();}count++;
      }
      await upload(positionals[2],positionals[3]||basename(positionals[2]));result={uploaded:count,machine};
    }else if(command==='download'&&positionals.length===4){
      const file=await open(positionals[3],'wx',0o600);let offset=0;
      try{while(true){const r=(await call('files.get',{machine:positionals[1],path:positionals[2],offset})).result;const data=Buffer.from(r.data,'base64');await file.writeFile(data);offset+=data.length;if(r.eof)break;if(!data.length)fail('Empty download chunk');}}finally{await file.close();}result={downloaded:positionals[3],bytes:offset};
    }else if(command==='grant'&&positionals.length===2){
      const userId=find(positionals[1]),policyVersion=state.users.find(u=>u.id===userId).policyVersion;
      if(options.full){result=(await call('policy.full',{userId,policyVersion})).result;}
      else{
      const limits={};for(const spec of options.machines){const pair=spec.split('=');if(pair.length!==2||!/^\d+$/.test(pair[1])||Object.hasOwn(limits,pair[0]))fail('Expected unique --machine NAME=CARDS');limits[pair[0]]=Number(pair[1]);}
      if(!/^\d+$/.test(options.total||''))fail('--total must be an integer');
      result=(await call('policy.save',{userId,limits,total:Number(options.total),...(state.demo?{}:{policyVersion})})).result;
      }
    }else if(command==='request'&&positionals.length===2){
      if(!/^\d+$/.test(options.cards||''))fail('--cards must be an integer');
      result=(await call('request',{userId:own(),machine:positionals[1],cards:Number(options.cards)})).result;
    }else if(command==='release'&&positionals.length===2)result=(await call('release',{userId:own(),jobId:positionals[1]})).result;
    else fail('Unknown command. Use --help.');
  }
  if(options.json){console.log(JSON.stringify({ok:true,...mode,data:result}));return;}
  if(command==='login'){console.log(`已登录：${result.principal.username}`);return;}
  if(command==='logout'){console.log('已退出登录。');return;}
  if(command==='use'){console.log(`当前服务器：${result.selected}`);return;}
  if(command==='run'){console.log(`已提交 ${result.id}\n${result.machine} · ${result.cards} 张 GPU · ${result.state}\n查看日志：gpuctl logs ${result.id}`);return;}
  if(command==='logs'){process.stdout.write(result.text+(result.text.endsWith('\n')?'':'\n'));return;}
  if(command==='cancel'){console.log(`任务 ${result.id}：${result.state}${result.cancelRequested?'（已请求取消，等待节点确认）':''}`);return;}
  if(command==='upload'){console.log(`已上传 ${result.uploaded} 个文件到 ${result.machine} 的个人工作区。`);return;}
  if(command==='download'){console.log(`已下载：${result.downloaded}（${result.bytes} 字节）`);return;}
  if(command==='jobs'){console.log(result.length?[...result].slice(-50).reverse().map(j=>`${j.id}  ${j.state}\n  ${j.machine} · ${j.cards} 张 · ${j.name||'train'}`).join('\n'):'暂无任务。');if(result.length>50)console.log('仅显示最近 50 条；完整记录：gpuctl jobs --json');return;}
  if(command==='files'){console.log(result.entries.map(f=>`${f.type==='directory'?'[目录]':'[文件]'} ${f.name}${f.type==='file'?'  '+f.size+' B':''}`).join('\n')||'目录为空。');return;}
  if(command==='users'){console.log(result.map(u=>`${u.username}  ${u.role==='admin'?'管理员':'普通用户'}  ${u.enabled?'启用':'暂停'}  总额度 ${u.total} 张\n  ${Object.entries(u.limits).map(([m,n])=>`${m}: ${n}`).join('，')||'尚未授权机器'}`).join('\n'));return;}
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(wantsJSON?JSON.stringify({ok:false,error:error.message}):`Error: ${error.message}`);process.exitCode=1;});
