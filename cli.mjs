#!/usr/bin/env node
import {readFile,mkdir,writeFile,chmod,unlink,open,lstat,readdir} from 'node:fs/promises';
import {dirname,join,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {createInterface} from 'node:readline/promises';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {uploadLocalDataset,workspaceDataPath,putWorkspaceData} from './client-data-upload.mjs';
import {runManualSync} from './client-snapshot-sync.mjs';
import {uploadTransfer,downloadTransfer,transferText} from './client-transfers.mjs';
import {runCloudImport} from './client-cloud-import.mjs';
import {runCommunityCommand,formatCommunityResult,communityJSON,communityHelp} from './community-cli.mjs';
import {watchJob} from './job-watch.mjs';
import {progressText} from './dist/job-progress.js';
import {elasticAllocation,allocationLabel,gpuPlacement} from './dist/gpu-allocation.js';
import {displayName,taskDescription} from './dist/task-metadata.js';

// Member metadata is untrusted even after submission validators improve: old
// stored records and older servers can still contain C1/ANSI or bidi controls.
const maintenanceVisible=(value,multiline=false)=>String(value??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>multiline&&c==='\n'?c:'\\u{'+c.codePointAt(0).toString(16).padStart(4,'0')+'}');
const maintenanceJSON=value=>JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>c.split('').map(unit=>'\\u'+unit.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
const terminalMetadata=(value,key='')=>typeof value==='string'?maintenanceVisible(value,['description','body'].includes(key)):
  Array.isArray(value)?value.map(item=>terminalMetadata(item,key)):
  value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([name,item])=>[maintenanceVisible(name),terminalMetadata(item,name)])):value;

const help=`GPUQ — 个人终端与 GPUQ 训练

${communityHelp}

日常命令（一次安装后直接使用 gpuctl）：
gpuctl login                     Sign in; remembers your account and service
gpuctl profile --display-name "张三"  Set your public submitter name
gpuctl queue [--machine SERVER]   Read authorized machines' task names and descriptions
gpuctl use gpu-1                  Select an approved server from your inventory
gpuctl project create my-project Create/select a project (shared base Python packages)
gpuctl project create clean --env-mode isolated  New venv without base site-packages
gpuctl project use my-project    Select an existing project on this server
gpuctl project list / status / publish
gpuctl ssh                       Develop in the selected project's private terminal
gpuctl ssh --root                Administrator: unrestricted host root terminal
gpuctl ssh --reconnect SESSION   Explicitly reconnect a detached/expired session
gpuctl ssh --reconnect SESSION --takeover  Replace its active writer explicitly
gpuctl exec -- id                Administrator: non-interactive host root command
gpuctl exec --detach -- bash -lc 'long-command'
gpuctl exec status HANDLE        Read bounded stdout, stderr, state and exit code
gpuctl exec cancel HANDLE        Cancel this host command and confirm cleanup
gpuctl maintenance list / show ID  Read historical records (workflow retired)
gpuctl maintenance status          Read persistent platform/machine maintenance
gpuctl maintenance on all --reason "存储维修" --revision N   Administrator: block new operations
gpuctl maintenance off SERVER --revision N                 Administrator: explicitly restore this scope
gpuctl push .                    Upload code to the selected project's draft
gpuctl project publish           Freeze code + private environment; wait for READY
gpuctl sync git LOCAL_REPO --to SERVER --project NEW --ref HEAD --dry-run
gpuctl sync code --from SOURCE --to TARGET --project SOURCE --target-project NEW --release HASH
gpuctl sync data NAME@VERSION --from SOURCE --to TARGET --name NAME --dry-run
gpuctl run -g 2 -- python train.py
gpuctl jobs / logs JOB / cancel JOB
gpuctl transfer upload LOCAL_DIR --name NAME [--machine SERVER]
gpuctl transfer download NAME@VERSION NEW_LOCAL_DIR [--machine SERVER]
gpuctl transfer copy NAME@VERSION --from SOURCE --to TARGET --name NAME --detach
gpuctl transfer list / status ID / watch ID / cancel ID / resume ID
gpuctl watch JOB                 Watch progress / completion / failure over SSH
gpuctl notify JOB on|off|status  Opt into your configured Telegram destination
gpuctl diagnostics JOB --json    Persistent bounded worker logs, exits and resource counters
gpuctl run --priority idle -g 1 -- python train.py
gpuctl run --rank P1 --yield save --checkpointable --restart-policy on-preempt -- python train.py
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 -- python train.py
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 --auto-expand --rank P1 --yield save --checkpointable --restart-policy on-preempt -- python train.py
gpuctl run --gpu 0,2 -- python train.py
gpuctl run --gpu 3 --share --vram-mib 4096 -- python small.py
gpuctl run --gpu 3 --share --vram-mib 4096 --hami --sm-percent 50 -- python small.py
gpuctl priority JOB high         Administrator: change queued job priority
gpuctl notes                     Shared task / persistent general notes
gpuctl note --job JOB "message"  Deleted when the task is confirmed finished
gpuctl note --general "notice"  Kept until manually deleted
gpuctl note-delete NOTE_ID       Delete own note (or any note as admin)
gpuctl pull --job JOB model.pt ./model.pt
gpuctl data list                 List authorized dataset versions on selected server
gpuctl data import LINK [REMOTE_FILE]  Download from Aliyun share / HTTPS to private /data2
gpuctl data imports              List your server-side downloads
gpuctl data import-status|import-resume|import-cancel|import-discard ID
gpuctl data import-resume ID --source-url HTTPS_LINK  Refresh the same file's link
gpuctl data put ARCHIVE [REMOTE_FILE]  Upload a file to your private /data2 (no extraction)
gpuctl data shell                Open your private /data2 terminal (no GPU)
gpuctl data files [DIRECTORY]    List your private data workspace
gpuctl data publish DIRECTORY --name NAME  Publish a prepared subdirectory, after exit
gpuctl data workspace-status [OPERATION_ID]  Inspect data workspace publication
gpuctl data upload LOCAL_DIR --name NAME  Prefer direct upload; repeat to resume
gpuctl data upload LOCAL_DIR --name NAME --via relay  Explicitly allow VPS relay
gpuctl data upload-status UPLOAD_ID  Inspect this account's upload and verification
gpuctl data upload-discard UPLOAD_ID  Cancel an unfinished upload (not a READY dataset)
gpuctl data prepare NAME@VERSION Prepare a local, verified copy without reserving GPUs
gpuctl data archive-retry NAME@VERSION  Retry long-term preservation; keeps the local original
gpuctl data unregister NAME[@VERSION]  Administrator: asynchronously unregister local data
gpuctl data status OPERATION_ID   Check a background operation; accepted is not completed
gpuctl data status NAME@VERSION  Inspect preparation state
gpuctl data storage status [NAME@VERSION]  Administrator: capacity and protection state
gpuctl data storage plan         Administrator: preview cache policy; never deletes
gpuctl data storage pin NAME@VERSION LABEL  Protect a manual job's dataset copy
gpuctl data storage unpin NAME@VERSION LABEL  Release that manual pin after its job stops
gpuctl run -g 2 --data NAME@VERSION -- python train.py --data /data2/NAME

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
gpuctl run gpu-1 --cards 1 --name train -- python train.py
gpuctl run -g 1 --name baseline --description "验证新数据集" -- python train.py
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
run --priority idle|normal|high selects training priority (default normal).
exec is separate from training/PTY: existing admins on hostRoot-enabled nodes only.
exec --cwd /absolute/path --timeout SECONDS (1..86400, default 300).
exec waits by default; --detach returns a handle. --json includes both output streams.
Use -- bash -lc '...' only when shell syntax is intended. argv is otherwise literal.
Host output retains the first 65536 bytes per stream; truncation is reported.
Reuse --key after an uncertain response; never retry with a new key blindly.
Projects are selected per server, never silently copied or moved between machines.
--project SLUG overrides the selection; --legacy explicitly uses the old workspace.
--release HASH pins a READY project release. Without it, run uses latest READY.
--job UUID selects a project's per-job outputs for files / pull (read-only to CLI).
Choose a server explicitly: new jobs do not accept auto.
Existing users without a selected project keep their legacy workspace.
The standard Python environment is /opt/conda; never modify global Conda.`;
const args=process.argv.slice(2);let options,positionals,training;
let wantsJSON=args.slice(0,args.includes('--')?args.indexOf('--'):args.length).includes('--json');
function fail(message){throw Error(message);}
const CLI_OPTIONS=new Map([
  ['pin','flag'],...['kind','status','title','body','body-file','announcement-type'].map(key=>[key,'value']),
  ['via','value'],
  ...['sha256','file-id','password-code','source-url'].map(key=>[key,'value']),
  ...['overwrite','json','password-stdin','credentials-stdin','help','full','root','legacy','detach','takeover','general','checkpointable','auto-expand','dry-run','share','hami','ack-unknown'].map(key=>[key,'flag']),
  ...['url','session-file','total','cards','as','role','name','description','display-name','min-vram','key','project','release','job','priority','cwd','timeout','reconnect','env-mode','rank','yield','restart-policy','mode','min-cards','global-batch','micro-batch','interval','from','to','ref','target-project','gpu','vram-mib','sm-percent','reason','script-file','revision','preview-token','parent','cursor','limit'].map(key=>[key,'value']),
  ['machine','machines'],['data','datasets'],
]);

export function parseCLIOptions(argv){
  const options={machines:[],datasets:[]},positionals=[];
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--')return {options,positionals,training:argv.slice(i+1)};
    const item=argv[i]==='-g'?'--cards':argv[i];
    if(!item.startsWith('--')){positionals.push(item);continue;}
    const key=item.slice(2),kind=CLI_OPTIONS.get(key);
    if(!kind)fail(`Unknown option: ${item}`);
    if(Object.hasOwn(options,key))fail(`Duplicate option: ${item}`);
    if(kind==='flag'){options[key]=true;continue;}
    const value=argv[++i];
    if(!value||value.startsWith('--'))fail(`Missing value: ${item}`);
    if(kind==='value')options[key]=value;
    else options[kind].push(value);
  }
  return {options,positionals,training:[]};
}
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
  ({options,positionals,training}=parseCLIOptions(args));
  if(options.help||!positionals.length){console.log(help);return;}
  const transferCopy=positionals[0]==='transfer'&&positionals[1]==='copy',transferWatch=positionals[0]==='transfer'&&positionals[1]==='watch',transferList=positionals[0]==='transfer'&&positionals[1]==='list';
  if(['ref','target-project','dry-run'].some(key=>Object.hasOwn(options,key))&&positionals[0]!=='sync'||['from','to'].some(key=>Object.hasOwn(options,key))&&positionals[0]!=='sync'&&!transferCopy)fail('--from/--to are for sync or transfer copy; ref/target-project/dry-run are only for sync');
  if(options.general&&positionals[0]!=='note')fail('--general is only valid for note');
  if(options.interval!==undefined&&positionals[0]!=='watch'&&!transferWatch)fail('--interval is only valid for watch');
  if(positionals[0]==='watch'){
    if(positionals.length!==2||training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','json','url','session-file','interval'].includes(k)))fail('Usage: watch JOB [--interval 1..60] [--json]');
    if(options.interval!==undefined&&(!Number.isFinite(Number(options.interval))||Number(options.interval)<1||Number(options.interval)>60))fail('--interval must be 1–60 seconds');
  }
  if(positionals[0]==='notify'&&(positionals.length!==3||!['on','off','status'].includes(positionals[2])||training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','json','url','session-file'].includes(k))))fail('Usage: notify JOB on|off|status');
  if(options.overwrite&&!(positionals[0]==='data'&&positionals[1]==='put'))fail('--overwrite is only valid for data put');
  if(options.via!==undefined&&(!((['data','transfer'].includes(positionals[0])&&positionals[1]==='upload')||(positionals[0]==='data'&&positionals[1]==='put'&&options.via!=='direct'))||!['auto','direct','relay'].includes(options.via)))fail('--via auto|direct|relay is for directory uploads; data put accepts only auto or relay');
  if(options.priority&&!['idle','normal','high'].includes(options.priority))fail('Priority must be idle, normal or high');
  if(options.priority&&positionals[0]!=='run')fail('--priority is only valid for run; use gpuctl priority JOB idle|normal|high');
  if(options.cwd!==undefined&&!['exec','maintenance'].includes(positionals[0])||options.timeout!==undefined&&!['exec','maintenance'].includes(positionals[0])&&!transferCopy||options.detach&&positionals[0]!=='exec'&&!transferCopy)fail('--cwd is for exec/maintenance; timeout also supports transfer copy; detach is for exec or transfer copy');
  if(['reason','script-file','preview-token','parent','ack-unknown'].some(key=>Object.hasOwn(options,key))&&positionals[0]!=='maintenance')fail('Maintenance options are only valid for maintenance');
  if(options.revision!==undefined&&!['maintenance','community'].includes(positionals[0])||['cursor','limit'].some(key=>Object.hasOwn(options,key))&&!['maintenance','community'].includes(positionals[0])&&!transferList)fail('--revision is for community/maintenance; cursor/limit also support transfer list');
  const customScheduling=['rank','yield','restart-policy','checkpointable','mode'].some(k=>Object.hasOwn(options,k));
  if(customScheduling&&(positionals[0]!=='run'||options.priority))fail('Custom scheduling is only valid for run and cannot mix with --priority presets');
  const scheduling=customScheduling?{rank:options.rank||'P2',yieldPolicy:options.yield||'never',restartPolicy:options['restart-policy']||'never',checkpointable:options.checkpointable===true}:null;
  if(options.mode){const modes={queue:'queue',preempt1:'preempt-save',preempt2:'preempt-now','preempt-save':'preempt-save','preempt-now':'preempt-now'};if(!Object.hasOwn(modes,options.mode))fail('Use --mode queue|preempt1|preempt2');if(modes[options.mode]!=='queue')scheduling.mode=modes[options.mode];}
  const elasticKeys=['min-cards','global-batch','micro-batch','auto-expand'];
  const placementKeys=['gpu','share','vram-mib','hami','sm-percent'];
  if(placementKeys.some(k=>Object.hasOwn(options,k))&&positionals[0]!=='run')fail('Placement options are only valid for run');
  if(elasticKeys.some(k=>Object.hasOwn(options,k))&&positionals[0]!=='run')fail('Elastic GPU options are only valid for run');
  if(scheduling){
    if(!/^P[0-4]$/.test(scheduling.rank)||!['never','now','save'].includes(scheduling.yieldPolicy)||!['never','on-preempt'].includes(scheduling.restartPolicy))fail('Use --rank P0..P4, --yield never|now|save, --restart-policy never|on-preempt');
    if(scheduling.yieldPolicy==='save'&&!scheduling.checkpointable)fail('--yield save requires --checkpointable and an epoch checkpoint adapter');
    if(scheduling.restartPolicy==='on-preempt'&&(scheduling.yieldPolicy!=='save'||!scheduling.checkpointable))fail('Automatic resume requires --yield save --checkpointable');
  }
  const projectSlug=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(value))fail('Project must start with a lowercase letter and use 1–48 lowercase letters, digits, _ or -');return value;};
  if(options.project)projectSlug(options.project);
  if(options.project&&options.legacy)fail('--project and --legacy cannot be combined');
  if(options.release&&!/^[a-f0-9]{64}$/.test(options.release))fail('Use --release FULL_64_CHARACTER_HASH');
  if(options.job&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.job))fail('Use --job JOB_UUID from gpuctl jobs');
  const explicitSession=options['session-file']||process.env.GPUQ_SESSION_FILE||process.env.AMAX_SESSION_FILE;
  if(options.description!==undefined&&positionals[0]!=='run')fail('--description is only valid for run');
  if(options['display-name']!==undefined&&!['profile','register'].includes(positionals[0]))fail('--display-name is only valid for profile or register');
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
  async function post(path,body,requestSignal){
    const response=await fetch(new URL(`/api/${path}`,base),{method:'POST',redirect:'error',signal:requestSignal?AbortSignal.any([requestSignal,AbortSignal.timeout(40000)]):AbortSignal.timeout(40000),headers:{'Content-Type':'application/json',...(session?{Authorization:`Bearer ${session.token}`}:{})},body:JSON.stringify(body)});
    let data;try{data=await response.json();}catch{fail('Target is not an GPUQ JSON API. The hosted static preview does not provide one.');}
    if(!response.ok)fail(data.error||`HTTP ${response.status}`);return data;
  }
  const call=(operation,args={},signal)=>post('call',{operation,args},signal);
  let command=positionals[0];let result,mode={demo:true,gpuqConnected:false};
  if(command==='register'){
    if(positionals.length!==2)fail('Usage: register USERNAME');
    if(options['password-stdin'])fail('Use --credentials-stdin with JSON {invite,password} for registration.');
    let credentials;
    if(options['credentials-stdin']){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>1024)fail('Registration input too long');}try{credentials=JSON.parse(value);}catch{fail('Expected JSON {invite,password} on stdin');}if(!credentials||typeof credentials!=='object'||Array.isArray(credentials)||Object.keys(credentials).some(key=>!['invite','password'].includes(key)))fail('Expected only invite and password');}
    else credentials={invite:await secret('Invite code'),password:await secret()};
    result=await post('register',{username:positionals[1],...credentials,...(options['display-name']?{name:displayName(options['display-name'])}:{})});mode={demo:false,gpuqConnected:false};
  }else if(command==='login'){
    if(positionals.length===1&&process.stdin.isTTY){const rl=createInterface({input:process.stdin,output:process.stdout});positionals.push(await rl.question('用户名: '));rl.close();}
    if(positionals.length!==2)fail('Usage: login USERNAME');
    const login=await post('login',{username:positionals[1],password:await secret()});
    mode={demo:login.state.demo,gpuqConnected:login.state.gpuqConnected===true};
    await mkdir(dirname(sessionFile),{recursive:true,mode:0o700});
    const previous=session?.principal?.userId===login.principal.userId?session:null;
    await writeFile(sessionFile,JSON.stringify({url:base.origin,token:login.token,principal:login.principal,...(previous?.machine?{machine:previous.machine}:{}),...(previous?.projectsByMachine?{projectsByMachine:previous.projectsByMachine}:{}),...(previous?.datasetUploadKeys?{datasetUploadKeys:previous.datasetUploadKeys}:{})}),{mode:0o600});await chmod(sessionFile,0o600);
    result={loggedIn:true,principal:login.principal};
  }else{
    if(!session)fail('请先登录：gpuctl login');
    const state=(await call('state')).state;
    const machineName=value=>{const exact=state.machines.find(m=>m.id===value);if(exact)return exact.id;const short=state.machines.filter(m=>m.id.endsWith('-'+value));return short.length===1?short[0].id:value;};
    const selectedMachine=()=>session.machine||(state.machines?.length===1?state.machines[0].id:null)||fail('先选择一次服务器：gpuctl use gpu-1');
    const defaultMachine=()=>{if(options.machines.length){if(options.machines.length!==1||options.machines[0].includes('='))fail('Use one --machine SERVER outside grant');return machineName(options.machines[0]);}return selectedMachine();};
    const selectedProject=machine=>options.legacy?null:options.project||session.projectsByMachine?.[machine]||null;
    const projectArgs=machine=>{const project=selectedProject(machine);return project?{project:projectSlug(project)}:{};};
    const fileArgs=machine=>{const context=projectArgs(machine);if(options.job&&!context.project)fail('--job outputs require a selected project; use gpuctl project use NAME');return {...context,...(context.project?{area:options.job?'output':'code',...(options.job?{runId:options.job}:{})}:{})};};
    const saveSession=async()=>{await writeFile(sessionFile,JSON.stringify(session),{mode:0o600});await chmod(sessionFile,0o600);};
    const shortcut=command;
    const dataTerminal=command==='data'&&positionals[1]==='shell';
    if(dataTerminal){
      if(positionals.length!==2||training.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json','reconnect','takeover'].includes(k)))fail('Usage: data shell [--machine SERVER] [--reconnect SESSION] [--takeover]');
      command='shell';positionals.splice(0,positionals.length,'shell',defaultMachine());
    }
    if(command==='ssh')command='shell';if(command==='push')command='upload';if(command==='pull')command='download';
    if((options.reconnect||options.takeover)&&command!=='shell')fail('--reconnect/--takeover are only valid for ssh');
    if(options['env-mode']!==undefined){
      if(command!=='project'||positionals[1]!=='create')fail('--env-mode is only valid for project create; existing environments are never rebuilt');
      if(!['shared','isolated'].includes(options['env-mode']))fail('--env-mode must be shared or isolated');
    }
    if(['run','shell'].includes(command)&&positionals.length===1)positionals.push(defaultMachine());
    if(['push','pull'].includes(shortcut))positionals.splice(1,0,defaultMachine());
    if(shortcut==='push'&&positionals.length===3&&(await lstat(positionals[2])).isDirectory())positionals.push('.');
    if(command==='files'&&(positionals.length===1||!state.machines.some(m=>m.id===machineName(positionals[1]))))positionals.splice(1,0,defaultMachine());
    if(['run','shell','upload','download','files','use'].includes(command)&&positionals[1])positionals[1]=machineName(positionals[1]);
    mode={demo:state.demo,gpuqConnected:state.gpuqConnected===true};
    const find=username=>{const user=state.users.find(u=>u.username===username);if(!user)fail('Unknown or unauthorized username');return user.id;};
    const own=()=>session.principal.role==='admin'&&options.as?find(options.as):session.principal.userId;
    if(command==='transfer'){
      const action=positionals[1],common=['machines','datasets','url','session-file','json','key'],specific={upload:['name','via'],download:[],copy:['from','to','name','timeout','detach'],list:['cursor','limit'],status:[],watch:['interval'],cancel:[],resume:[]}[action];
      if(!specific||training.length||options.datasets.length||Object.keys(options).some(k=>!common.includes(k)&&!specific.includes(k)))fail('Usage: transfer upload|download|copy|list|status|watch|cancel|resume');
      const progress=(phase,v)=>process.stderr.write(phase==='ROUTE'?(v.kind==='campus-direct'?'传输路径：直连上传节点（文件不经平台中转）\n':`传输路径：VPS 中转${v.explicit?'（已明确选择）':'（小文件通道）'}\n`):`${phase} · ${v.transferId||v.path||''}${v.bytes!==undefined?' · '+v.bytes+' / '+(v.totalBytes??'?')+' bytes':''}\n`);
      if(action==='upload'){
        if(positionals.length!==3)fail('Usage: transfer upload LOCAL_DIR --name NAME');
        result=await uploadTransfer(call,{machine:defaultMachine(),name:options.name,userId:session.principal.userId,directory:positionals[2],key:options.key,progress,via:options.via||'auto'});
      }else if(action==='download'||action==='copy'){
        if(positionals.length!==(action==='download'?4:3))fail('Usage: transfer download NAME@VERSION NEW_DIR | transfer copy NAME@VERSION --from SOURCE --to TARGET --name NAME');
        const [dataset,version,...extra]=positionals[2].split('@');if(extra.length||!dataset||!/^[a-f0-9]{64}$/.test(version||''))fail('Select NAME@FULL_VERSION_HASH');
        if(action==='download')result=await downloadTransfer(call,{machine:defaultMachine(),dataset,version,destination:positionals[3],key:options.key,progress});
        else{
          if(options.machines.length||!options.from||!options.to)fail('copy requires --from and --to; no auto placement');
          const key=options.key||randomUUID();process.stderr.write('重试键：'+key+'（未确认时重复原命令并加 --key，不要换键）\n');
          result=(await call('transfers.create',{key,kind:'copy',from:machineName(options.from),machine:machineName(options.to),name:options.name,dataset,version,...(options.timeout?{timeoutSec:Number(options.timeout)}:{})})).result;
          if(!options.detach){while(!['SUCCEEDED','FAILED','PAUSED','CANCELED','UNKNOWN'].includes(result.state)){process.stderr.write(transferText(result)+'\n');await new Promise(r=>setTimeout(r,2000));result=(await call('transfers.status',{id:result.id})).result;}}
        }
      }else if(action==='list'){
        if(positionals.length!==2)fail('Usage: transfer list');result=(await call('transfers.list',{...(options.cursor?{cursor:Number(options.cursor)}:{}),...(options.limit?{limit:Number(options.limit)}:{})})).result;
      }else{
        if(positionals.length!==3)fail('Usage: transfer '+action+' ID');
        if(action==='watch'){
          const interval=Number(options.interval??2);if(!Number.isFinite(interval)||interval<1||interval>60)fail('Watch interval must be 1–60 seconds');
          do{result=(await call('transfers.status',{id:positionals[2]})).result;process.stderr.write(transferText(result)+'\n');if(['SUCCEEDED','FAILED','PAUSED','CANCELED','UNKNOWN','WAITING_CLIENT'].includes(result.state))break;await new Promise(r=>setTimeout(r,interval*1000));}while(true);
        }else result=(await call('transfers.'+action,{id:positionals[2]})).result;
      }
    }else if(command==='community'){
      result=await runCommunityCommand({positionals,options,training,call});
    }else if(command==='sync'){
      result=await runManualSync(call,{options,positionals,training,machines:state.machines,userId:session.principal.userId});
    }else if(command==='queue'){
      if(positionals.length!==1||training.length||options.datasets.length||options.machines.length>1||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json'].includes(k)))fail('Usage: queue [--machine SERVER]');
      if(state.taskMetadata?.version!==1)fail('当前后台尚未支持公开任务信息，请升级门户。');
      const selected=options.machines.length?machineName(options.machines[0]):null;
      if(selected&&!state.machines.some(m=>m.id===selected))fail('这台机器未授权或不存在');
      result={stale:state.gpuq?.stale!==false,hosts:(state.gpuq?.hosts||[]).filter(h=>!selected||h.id===selected).map(h=>({machine:h.id,reachable:h.reachable,checkedAt:state.gpuq.checkedAt,tasks:h.tasks||[]}))};
    }else if(command==='profile'){
      if(positionals.length!==1||training.length||options.datasets.length||options.machines.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json','display-name'].includes(k)))fail('Usage: profile [--display-name NAME]');
      if(options['display-name']){if(state.taskMetadata?.version!==1)fail('当前后台尚未支持姓名设置，请升级门户。');result=(await call('profile.update',{name:displayName(options['display-name'])})).result;}
      else result=state.users.find(u=>u.id===session.principal.userId);
    }else if(command==='use'&&positionals.length===2){
      if(!state.machines.some(m=>m.id===positionals[1]))fail('这台机器未授权或不存在');session.machine=positionals[1];await saveSession();result={selected:session.machine,project:selectedProject(session.machine)};
    }else if(command==='maintenance'){
      const action=positionals[1];
      if(['status','on','off'].includes(action)){
        if(state.operationalMaintenance?.version!==1)fail('当前后台尚未支持持久维护状态。');
        const allowed=['machines','datasets','url','session-file','json',...(action==='status'?[]:['reason','revision'])];
        if(training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!allowed.includes(k))||positionals.length!==(action==='status'?2:3))fail('Usage: maintenance status | maintenance on all|SERVER --reason TEXT --revision N | maintenance off all|SERVER --revision N');
        if(action==='status')result=(await call('maintenance.status')).result;
        else{
          if(session.principal.role!=='admin')fail('仅管理员可设置或解除维护状态。');
          if(!/^\d+$/.test(options.revision||'')||!Number.isSafeInteger(Number(options.revision)))fail('先 maintenance status，再用显示的 --revision N 明确操作。');
          result=(await call('maintenance.set',{scope:positionals[2],enabled:action==='on',revision:Number(options.revision),...(options.reason!==undefined?{reason:options.reason}:{})})).result;
        }
      }else{
      if(!['list','show'].includes(action))fail('维护申请已停用，仅支持 maintenance list / show ID 查看历史。系统依赖请在协作区反馈；管理员可使用 gpuctl exec 或独立 ROOT 终端。');
      if(state.demo||state.maintenance?.version!==1)fail('当前后台不提供历史运维记录。');
      const common=['machines','datasets','url','session-file','json','help'],specific=action==='list'?['cursor','limit']:[];
      if(training.length||options.machines.length||options.datasets.length||Object.keys(options).some(key=>!common.includes(key)&&!specific.includes(key)))fail('历史查询仅支持 list --cursor/--limit 或 show ID。');
      if(action==='list'?positionals.length!==2:positionals.length!==3)fail('Usage: maintenance list | maintenance show ID');
      const number=(value,label)=>{if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))fail(label+' 必须为整数');return Number(value);};
      if(action==='list')result=(await call('maintenance.list',{...(options.cursor?{cursor:options.cursor}:{}),...(options.limit?{limit:number(options.limit,'limit')}:{})})).result;
      else result=(await call('maintenance.get',{id:positionals[2]})).result;
      }
    }else if(command==='exec'){
      if(['as','project','release','job','root','legacy','cards','min-vram','name'].some(key=>Object.hasOwn(options,key))||options.datasets.length)fail('exec only accepts host-command options; project/training/impersonation flags are not supported');
      if(session.principal.role!=='admin')fail('Host commands require an existing administrator account');
      const action=['status','cancel'].includes(positionals[1])?positionals[1]:'exec';
      if(options.machines.length>1||options.machines.some(value=>value.includes('=')))fail('Use exactly one --machine SERVER');
      if(action==='exec'&&positionals.length>2||action!=='exec'&&positionals.length!==3)fail('Usage: exec [SERVER] -- argv... | exec status|cancel HANDLE [--machine SERVER]');
      if(action==='exec'&&positionals[1]&&options.machines.length)fail('Select a server once, either positionally or with --machine');
      const explicit=action==='exec'?positionals[1]:null;
      const machine=machineName(explicit||options.machines[0]||session.machine||fail('Select a server explicitly: gpuctl use gpu-1, or exec --machine gpu-1'));
      if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('This server is not explicitly selected and authorized');
      const terminal=new Set(['SUCCEEDED','FAILED','CANCELED','TIMED_OUT']);
      let request;
      if(action==='exec'){
        const host=state.gpuq?.hosts?.find(h=>h.id===machine);
        if(state.gpuq?.stale!==false||host?.reachable!==true||host.hostCommand?.version!==1||host.hostCommand?.available!==true)
          fail('这台服务器尚未启用或尚未确认管理员非交互命令，未提交命令；请联系管理员。已有 ROOT 终端不受影响。');
        if(!training.length)fail('Put the host command argv after --');
        const timeout=options.timeout===undefined?300:Number(options.timeout);
        if(options.timeout!==undefined&&!/^\d+$/.test(options.timeout)||!Number.isInteger(timeout)||timeout<1||timeout>86400)fail('--timeout must be an integer from 1 to 86400 seconds');
        if(options.cwd&&(!options.cwd.startsWith('/')||options.cwd.includes('\0')||options.cwd.length>1024))fail('--cwd must be an absolute path');
        const key=options.key||randomUUID();
        if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key))fail('--key must be a UUID');
        process.stderr.write(`Host command key: ${key} · server: ${machine}\n`);
        request={machine,key,argv:training,timeoutSec:timeout,...(options.cwd?{cwd:options.cwd}:{})};
        try{result=(await call('host.exec',request)).result;}
        catch(error){fail(`${error.message}\nCommand state is unconfirmed, not canceled. Inspect: gpuctl exec status ${key} --machine ${machine}; retry submission only with the SAME --key ${key}.`);}
      }else{
        if(training.length||['key','cwd','timeout','detach'].some(key=>Object.hasOwn(options,key)))fail('exec status/cancel accepts only HANDLE and --machine');
        const id=positionals[2];if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))fail('Command handle must be a UUID');
        result=(await call('host.'+action,{machine,id})).result;
      }
      const handle=result.id;
      if(action==='exec'&&!options.detach){
        try{
          while(!terminal.has(result.state)&&result.state!=='UNKNOWN'){
            await new Promise(resolve=>setTimeout(resolve,500));
            result=(await call('host.status',{machine,id:handle})).result;
          }
        }catch(error){fail(`${error.message}\nCommand may still be running; no cancellation was sent. Inspect: gpuctl exec status ${handle} --machine ${machine}`);}
      }
      result={...result,machine};
      if(terminal.has(result.state))process.exitCode=result.state==='TIMED_OUT'?124:result.state==='CANCELED'?130:Number.isInteger(result.exitCode)?Math.min(255,Math.max(0,result.exitCode)):result.signal?Math.min(255,128+result.signal):result.state==='SUCCEEDED'?0:1;
      else if(result.state==='UNKNOWN')process.exitCode=3;
    }else if(command==='project'&&['list','create','use','status','publish'].includes(positionals[1])){
      if(options.legacy)fail('Project commands do not accept --legacy');
      const action=positionals[1],machine=defaultMachine();
      if(!state.machines.some(m=>m.id===machine))fail('这台机器未授权或不存在');
      if(action==='list'){
        if(positionals.length!==2||options.project)fail('Usage: project list [--machine SERVER]');
        result=(await call('projects.list',{machine})).result;
      }else{
        if(positionals.length>3)fail('Usage: project create|use NAME | project status|publish [NAME]');
        const project=projectSlug(positionals[2]||options.project||(['status','publish'].includes(action)?selectedProject(machine):null));
        if(positionals[2]&&options.project&&positionals[2]!==options.project)fail('Conflicting project names');
        if(options.key)fail('--key is for training submissions; publication is tracked per project with project status');
        result=(await call(`projects.${action==='use'?'status':action}`,{machine,project,...(options['env-mode']!==undefined?{environmentMode:options['env-mode']}:{})})).result;
        if(options['env-mode']==='isolated'&&result.environmentMode!=='isolated')fail('Node did not confirm isolated environment mode. Upgrade the node and inspect the project before installing dependencies; no shared-mode fallback was accepted.');
        if(action==='create'||action==='use'){
          session.projectsByMachine={...session.projectsByMachine,[machine]:project};await saveSession();
          result={...result,machine,selectedProject:project};
        }
      }
    }else if(command==='shell'&&positionals.length===2){
      if(!process.stdin.isTTY)fail('交互终端需要 TTY；非交互任务使用 gpuctl run');
      const machine=positionals[1],hostAdmin=options.root===true;
      if(hostAdmin&&(options.project||options.job))fail('Host root terminal does not accept --project or --job');
      if(options.takeover&&!options.reconnect)fail('--takeover requires --reconnect SESSION');
      if(options.reconnect&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.reconnect))fail('Reconnect requires a complete terminal UUID');
      const context=dataTerminal?{dataWorkspace:true}:hostAdmin?{}:projectArgs(machine);
      const clientId=randomUUID();
      const opened=(await call('terminal.open',{machine,key:randomUUID(),clientId,mode:options.reconnect?'reconnect':'new',...(options.reconnect?{id:options.reconnect,takeover:options.takeover===true}:{}),hostAdmin,...context})).result;
      if(!opened.writerToken)fail('Server terminal protocol is too old; upgrade the node before attaching. No input was sent.');
      let input=Buffer.alloc(0),offset=0,done=false,closed=false,delay=250,lastSize='';
      const sessionArgs={machine,id:opened.id,clientId,writerToken:opened.writerToken,hostAdmin,...context};
      process.stderr.write(`\r\n${machine} · ${dataTerminal?'个人数据 /data2':hostAdmin?'ROOT 宿主机':context.project?'项目 '+context.project:'个人工作区'} · ${opened.id}（Ctrl+] 仅断开；exit 结束此会话）\r\n`);
      process.stdin.setRawMode(true);process.stdin.resume();
      const listener=chunk=>{if(chunk.includes(29)){done=true;return;}input=Buffer.concat([input,chunk]);if(input.length>262144)process.stdin.pause();};process.stdin.on('data',listener);
      try{while(!done){const sent=input.subarray(0,8192);input=input.subarray(sent.length);if(input.length<131072)process.stdin.resume();const size={cols:process.stdout.columns||110,rows:process.stdout.rows||32},sizeKey=JSON.stringify(size);const response=(await call('terminal.exchange',{...sessionArgs,offset,input:sent.toString('base64'),...(sizeKey===lastSize?{}:{cols:size.cols,rows:size.rows})})).result;lastSize=sizeKey;offset=response.offset;if(response.data)process.stdout.write(Buffer.from(response.data,'base64'));if(response.exited){await call('terminal.close',sessionArgs);closed=true;break;}await new Promise(r=>setTimeout(r,delay));}}
      finally{process.stdin.off('data',listener);process.stdin.setRawMode(false);process.stdin.pause();if(!closed)try{await call('terminal.detach',sessionArgs);}catch{process.stderr.write('\r\n写入权释放未确认；等待 30 秒或明确接管后再重连。\r\n');}process.stderr.write(`\r\n${closed?'此终端已结束。':`已断开，终端继续运行。重连：gpuctl ${dataTerminal?'data shell --machine '+machine:'ssh '+machine+(hostAdmin?' --root':context.project?' --project '+context.project:'')} --reconnect ${opened.id}`}\r\n`);}return;
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
    }else if(command==='data'&&['import','imports','import-status','import-resume','import-cancel','import-discard'].includes(positionals[1])){
      if(training.length)fail('导入不接受额外命令。');
      result=await runCloudImport({action:positionals[1],positionals,options,machine:defaultMachine(),call});
    }else if(command==='data'&&['put','files','publish','workspace-status'].includes(positionals[1])){
      const action=positionals[1],allowed=['machines','datasets','url','session-file','json',...(action==='put'?['overwrite','via']:action==='publish'?['name','key']:[])];
      if(training.length||options.datasets.length||Object.keys(options).some(k=>!allowed.includes(k)))fail('Personal data commands do not accept project, root or training options');
      const machine=defaultMachine();if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      if(action==='put'){
        if(positionals.length<3||positionals.length>4)fail('Usage: data put LOCAL_FILE [REMOTE_FILE] [--overwrite]');
        result=await putWorkspaceData(call,machine,positionals[2],positionals[3]||basename(positionals[2]),options.overwrite,{via:options.via||'auto'});
      }else if(action==='files'){
        if(positionals.length>3)fail('Usage: data files [RELATIVE_DIRECTORY]');
        result=(await call('datasets.workspace.list',{machine,path:workspaceDataPath(positionals[2]||'.',{directory:true})})).result;
      }else if(action==='publish'){
        if(positionals.length!==3||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(options.name||''))fail('Usage: data publish DIRECTORY --name NAME');
        const path=workspaceDataPath(positionals[2]),key=options.key||randomUUID();
        if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key))fail('Use a UUID publication --key');
        process.stderr.write(`Publication key: ${key}\n`);
        result={...(await call('datasets.workspace.publish',{machine,path,name:options.name,key})).result,machine};
      }else{
        if(positionals.length>3)fail('Usage: data workspace-status [OPERATION_ID]');
        if(positionals[2]&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(positionals[2]))fail('Use the complete publication UUID');
        result={...(await call('datasets.workspace.status',{machine,...(positionals[2]?{operationId:positionals[2]}:{})})).result,machine};
        if(result.state==='FAILED')process.exitCode=1;else if(result.state==='UNKNOWN')process.exitCode=3;
      }
    }else if(command==='data'&&positionals[1]==='upload'){
      if(positionals.length!==3||training.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json','name','via'].includes(k)))fail('Usage: data upload LOCAL_DIR --name NAME [--machine SERVER] [--via auto|direct|relay]');
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(options.name||''))fail('Dataset name must be 1–40 ASCII letters, digits, _ or -, beginning with a letter or digit');
      const machine=defaultMachine();if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      let last=0,phase='';const progress=(next,value)=>{if(next==='HANDLE'){process.stderr.write(`Upload: ${value.uploadId} · ${value.machine}\n`);return;}if(next==='ROUTE'){process.stderr.write(value.kind==='campus-direct'?'传输路径：直连上传节点（文件不经平台中转）\n':`传输路径：VPS 中转${value.explicit?'（已明确选择）':'（小文件通道）'}\n`);return;}const now=Date.now();if(next!==phase||now-last>1000){phase=next;last=now;process.stderr.write(`${next}${value.bytes!==undefined?' · '+value.bytes+(value.totalBytes!==undefined?' / '+value.totalBytes:'')+' bytes':''}${value.path?' · '+value.path:''}\n`);}};
      const keyStore={get:key=>session.datasetUploadKeys?.[key],set:async(key,value)=>{session.datasetUploadKeys={...session.datasetUploadKeys,[key]:value};await saveSession();}};
      result=await uploadLocalDataset(call,{machine,name:options.name,userId:session.principal.userId,directory:positionals[2],progress,keyStore,via:options.via||'auto'});
    }else if(command==='data'&&['upload-status','upload-discard'].includes(positionals[1])){
      if(positionals.length!==3||training.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json'].includes(k)))fail('Usage: data upload-status|upload-discard UPLOAD_ID [--machine SERVER]');
      const machine=defaultMachine();if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      result={...(await call('datasets.upload.'+(positionals[1]==='upload-status'?'status':'discard'),{machine,uploadId:positionals[2]})).result,machine};if(result.state==='FAILED')process.exitCode=1;
    }else if(command==='data'&&positionals[1]==='storage'){
      if(session.principal.role!=='admin')fail('Storage management requires an administrator account');
      if(training.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json'].includes(k)))fail('Storage commands accept only one --machine SERVER and --json');
      const action=positionals[2]||'status',machine=defaultMachine();
      if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      if(!['status','plan','pin','unpin'].includes(action))fail('Usage: data storage status [NAME@VERSION] | plan | pin|unpin NAME@VERSION LABEL');
      const expected=action==='status'?[2,3,4]:action==='plan'?[3]:[5];
      if(!expected.includes(positionals.length))fail('Invalid number of storage command arguments');
      let ref={};
      if(positionals[3]){
        const parts=positionals[3].split('@');
        if(parts.length!==2||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(parts[0])||!/^[a-f0-9]{64}$/.test(parts[1]))fail('Use NAME@FULL_VERSION_HASH');
        ref={dataset:parts[0],version:parts[1]};
      }
      if(['pin','unpin'].includes(action)){
        const pinId=positionals[4];
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(pinId)||pinId.startsWith('authority-'))fail('Use a manual pin label; authority retention cannot be removed here');
        ref.pinId=pinId;
      }
      result={...(await call('datasets.storage.'+action,{machine,...ref})).result,machine};
    }else if(command==='data'&&['list','prepare','status','unregister','archive-retry'].includes(positionals[1])){
      if(positionals.length!==(positionals[1]==='list'?2:3))fail('Usage: data list | data prepare NAME@VERSION | data status NAME@VERSION|OPERATION_ID | data unregister NAME[@VERSION]');
      if(training.length||options.datasets.length||['as','project','release','job','root','legacy','cards','min-vram','name','key','total','role','full'].some(key=>Object.hasOwn(options,key)))fail('data commands accept only the dataset reference and one --machine SERVER');
      const action=positionals[1],machine=defaultMachine(),byOperation=action==='status'&&/^[a-f0-9]{64}$/.test(positionals[2]||'');
      if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      let reference={};
      if(byOperation)reference={operationId:positionals[2]};
      else if(action!=='list'){
        const ref=positionals[2].split('@');
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ref[0])||ref.length>2||
          (ref.length===2&&!/^[a-f0-9]{64}$/.test(ref[1]))||(action!=='unregister'&&ref.length!==2))fail('Use NAME@FULL_VERSION_HASH; only unregister also accepts a bare NAME');
        reference={dataset:ref[0],...(ref.length===2?{version:ref[1]}:{})};
      }
      if(action==='unregister'&&session.principal.role!=='admin')fail('Dataset unregister requires an administrator account');
      try{result=(await call(action==='archive-retry'?'datasets.archive.retry':'datasets.'+action,{machine,...reference})).result;}
      catch(error){if(action==='unregister')fail(`${error.message}\nUnregister outcome is unconfirmed; a background worker may still run. Inspect node operations before retrying.`);throw error;}
      if(action==='unregister'||byOperation){result={...result,machine};if(result.state==='FAILED')process.exitCode=1;else if(result.state==='UNKNOWN')process.exitCode=3;}
    }else if(command==='run'&&positionals.length===2){
      if(options.as)fail('--as cannot be used for real execution');
      if(positionals[1]==='auto')fail('请手选服务器：gpuctl use gpu-1；GPU 数量由 -g 指定，在该机内自动分配');
      if(!training.length)fail('Put the training command after --');
      const context=projectArgs(positionals[1]);
      if(options.release&&!context.project)fail('--release requires a selected project');
      if(context.project){
        const current=(await call('projects.status',{machine:positionals[1],project:context.project})).result;
        const release=options.release||current.latestReadyRelease;
        if(!release||!/^[a-f0-9]{64}$/.test(release)||!current.releases?.some(r=>r.release===release&&r.state==='READY'))fail('项目还没有指定的 READY 版本。先执行 gpuctl project publish，再用 gpuctl project status 确认；run 不会自动发布。');
        context.release=release;process.stderr.write(`Project: ${context.project} · release: ${release}\n`);
      }
      const key=options.key||randomUUID();process.stderr.write(`Submission key: ${key}\n`);
      const datasets=options.datasets.map(value=>{const [dataset,version,...extra]=value.split('@');if(extra.length||!dataset||!/^[a-f0-9]{64}$/.test(version||''))fail('Use --data NAME@FULL_VERSION_HASH');return {dataset,version};});
      const indices=options.gpu?.split(',').map(n=>/^\d+$/.test(n)?Number(n):NaN),cards=Number(options.cards||indices?.length||1);
      const elastic=elasticKeys.some(k=>Object.hasOwn(options,k))?elasticAllocation({minCards:Number(options['min-cards']),globalBatch:Number(options['global-batch']),microBatch:Number(options['micro-batch']),autoExpand:options['auto-expand']===true},cards,scheduling).elastic:null;
      const placement=placementKeys.some(k=>Object.hasOwn(options,k))?gpuPlacement({gpuIndices:indices,shared:options.share===true,...(options['vram-mib']?{vramMiB:Number(options['vram-mib'])}:{}),hami:options.hami===true,...(options['sm-percent']?{smPercent:Number(options['sm-percent'])}:{})},cards,elastic,scheduling,options.priority):null;
      if(options.description!==undefined&&state.taskMetadata?.version!==1)fail('当前后台尚未支持任务描述；不会忽略你填写的内容。');
      result=(await call('jobs.submit',{machine:positionals[1],cards,minVramGiB:Number(options['min-vram']||0),name:options.name||'train',...(options.description!==undefined?{description:taskDescription(options.description)}:{}),argv:training,key,...(options.priority?{priority:options.priority}:{}),...(scheduling?{scheduling}:{}),...(elastic?{elastic}:{}),...(placement?{placement}:{}),...context,...(datasets.length?{datasets,prepareData:true}:{})})).result;
    }else if(command==='jobs'&&positionals.length===1)result=state.jobs;
    else if(command==='priority'&&positionals.length===3){
      if(!['idle','normal','high','P0','P1','P2','P3','P4'].includes(positionals[2]))fail('Queue rank must be P0..P4 (or idle, normal, high); yielding/restart stay unchanged');
      if(options.key||training.length)fail('priority does not accept a submission key or command argv');
      result=(await call('jobs.priority',{jobId:positionals[1],priority:positionals[2]})).result;
    }
    else if(command==='diagnostics'){
      if(positionals.length!==2||training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','json','url','session-file'].includes(k)))fail('Usage: diagnostics JOB [--json]; no paths, machine or execution options');
      result=(await call('jobs.diagnostics',{jobId:positionals[1]})).result;
    }
    else if(command==='watch'&&positionals.length===2){
      const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
      try{process.exitCode=await watchJob(call,positionals[1],{interval:options.interval===undefined?5:Number(options.interval),json:options.json===true,signal:controller.signal});}
      finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}return;
    }
    else if(command==='notify'&&positionals.length===3)result=(await call('notifications.job',{jobId:positionals[1],...(positionals[2]==='status'?{}:{enabled:positionals[2]==='on'})})).result;
    else if(command==='notes'&&positionals.length===1){
      result=(await call('community.notes.list',{})).result;
    }else if(command==='note'&&positionals.length===2){
      if(Boolean(options.general)===Boolean(options.job))fail('Choose --job JOB_ID or --general for a note');
      const key=options.key||randomUUID();process.stderr.write(`Note key: ${key}; reuse --key after an uncertain response.\n`);
      result=(await call('community.notes.create',{body:positionals[1],key,...(options.job?{jobId:options.job}:{})})).result;
    }else if(command==='note-delete'&&positionals.length===2){
      const {note}=(await call('community.notes.get',{id:positionals[1]})).result;
      result=(await call('community.notes.delete',{id:note.id,revision:note.revision})).result;
    }
    else if(['logs','cancel'].includes(command)&&positionals.length===2)result=(await call(command==='logs'?'jobs.logs':'jobs.cancel',{jobId:positionals[1]})).result;
    else if(command==='files'&&positionals.length<=3)result=(await call('files.list',{machine:positionals[1],path:positionals[2]||'.',...fileArgs(positionals[1])})).result;
    else if(command==='upload'&&positionals.length>=3&&positionals.length<=4){
      if(options.job)fail('Job outputs cannot be uploaded; upload project code without --job');
      const machine=positionals[1],context=fileArgs(machine);let count=0,skipped=0;
      const excluded=name=>['.git','.ssh','.aws','.azure','.venv','venv','node_modules','__pycache__','id_rsa','id_ed25519','.env'].includes(name)||(name.startsWith('.env.')&&name!=='.env.example');
      const stable=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
      async function upload(local,path){
        if(context.project&&excluded(basename(local))){skipped++;process.stderr.write(`跳过项目上传：${local}\n`);return;}
        const st=await lstat(local);if(st.isSymbolicLink())fail('Symlink upload is not supported');
        if(st.isDirectory()){for(const name of await readdir(local))await upload(join(local,name),path==='.'?name:`${path}/${name}`);return;}
        if(!st.isFile())fail('Only regular files/directories can be uploaded');
        if(context.project&&st.size>4*1024**3)fail('Project code files are limited to 4 GiB; use the dataset workflow for large data');
        const file=await open(local,'r');let offset=0;
        try{
          const initial=await file.stat();if(!initial.isFile()||!stable(st,initial))fail('Local file changed before upload');
          let identity={};
          if(context.project){
            const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let at=0;
            while(at<initial.size){const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,initial.size-at),at);if(!bytesRead)fail('Local file changed during hashing');hash.update(buffer.subarray(0,bytesRead));at+=bytesRead;}
            if(!stable(initial,await file.stat()))fail('Local file changed during hashing');
            identity={totalSize:initial.size,sha256:hash.digest('hex'),uploadId:randomUUID()};
          }
          do{
            const buffer=Buffer.alloc(1024*1024);const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,Math.max(0,initial.size-offset)),offset);
            if(!bytesRead&&offset<initial.size)fail('Local file changed during upload');
            const final=offset+bytesRead===initial.size;
            if(context.project&&final&&!stable(initial,await file.stat()))fail('Local file changed during upload; no final publish was sent');
            const response=(await call('files.put',{machine,path,offset,...context,...(context.project?{...identity,final}:{truncate:offset===0}),data:buffer.subarray(0,bytesRead).toString('base64')})).result;
            if(context.project&&final&&(response?.complete!==true||response.sha256!==identity.sha256||response.size!==identity.totalSize))fail('Server did not confirm the complete verified upload; check and retry this file before publishing');
            offset+=bytesRead;
          }while(offset<initial.size);
          if(context.project&&!stable(initial,await file.stat()))fail('Local file changed during upload; verify and upload again before project publish');
        }finally{await file.close();}count++;
      }
      await upload(positionals[2],positionals[3]||basename(positionals[2]));result={uploaded:count,machine,...(context.project?{project:context.project,skipped}:{})};
    }else if(command==='download'&&positionals.length===4){
      const context=fileArgs(positionals[1]);
      const file=await open(positionals[3],'wx',0o600);let offset=0;
      try{while(true){const r=(await call('files.get',{machine:positionals[1],path:positionals[2],offset,...context})).result;const data=Buffer.from(r.data,'base64');await file.writeFile(data);offset+=data.length;if(r.eof)break;if(!data.length)fail('Empty download chunk');}}finally{await file.close();}result={downloaded:positionals[3],bytes:offset};
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
  // JSON escapes are lossless for callers while also safe to print in a terminal.
  if(options.json){console.log((command==='community'?communityJSON:maintenanceJSON)({ok:true,...mode,data:result}));return;}
  // Explicit log/host-command streams remain raw; historical maintenance and
  // community have their own safe formatters. Never alter arguments or storage.
  if(!['logs','exec','maintenance','community'].includes(command))result=terminalMetadata(result);
  if(command==='community'){console.log(formatCommunityResult(result));return;}
  if(command==='login'){console.log(`已登录：${result.principal.username}`);return;}
  if(command==='profile'){console.log(`姓名／显示名：${result.name}\n登录用户名：${result.username}`);return;}
  if(command==='queue'){if(result.stale)console.log('监控已过期；以下是平台记录与上次核对状态，不代表空闲。');for(const h of result.hosts){console.log(`${h.machine} · ${h.reachable?'可采集':'监控不可用'} · ${h.checkedAt||'暂无采集时间'}`);for(const t of h.tasks)console.log(`  ${t.id} · ${t.state} · ${t.name}\n  提交者：${t.submitter?.name||'未知'}${t.submitter?.username&&t.submitter.username!==t.submitter.name?'（'+t.submitter.username+'）':''}\n  描述：${t.description||'未填写描述'}\n  分配 GPU：${t.assignedGpuIndices?.join(', ')||'—'}`);if(!h.tasks.length)console.log('  暂无任务记录。');}return;}
  if(command==='logout'){console.log('已退出登录。');return;}
  if(command==='sync'){
    if(result.state==='PREVIEW')console.log(`同步预览：${result.source?.commit||result.source?.machine||'Git'} → ${result.target}\n${result.project||result.name} · ${result.bytes} B · ${result.entries} 项\n未写入目标。去掉 --dry-run 执行，重复原命令可续传。`);
    else if(result.state==='CODE_READY')console.log(`代码已校验：${result.machine} / ${result.project}\n在目标准备项目环境，再 project publish，等 READY 后训练。环境未复制。`);
    else console.log(`数据已就绪：${result.machine}\n${result.dataset}@${result.version}\n训练使用 --data ${result.dataset}@${result.version}`);
    return;
  }
  if(command==='use'){console.log(`当前服务器：${result.selected}\n${result.project?'当前项目：'+result.project:'未选择项目；可用 gpuctl project create NAME 或 project use NAME'}`);return;}
  if(command==='data'&&positionals[1]==='put'){console.log(`已上传 ${result.bytes} 字节 → ${result.machine}:${result.path}\n未自动解压或发布。进入个人数据终端：gpuctl data shell`);return;}
  if(command==='data'&&['publish','workspace-status'].includes(positionals[1])){console.log(`${result.state} · ${result.machine}${result.error?'\n'+result.error:''}${result.operationId?'\n查看：gpuctl data workspace-status '+result.operationId+' --machine '+result.machine:''}${result.state==='READY'?'\n数据集：'+result.dataset+'@'+result.version+'\n训练只读路径：/data2/'+result.dataset:''}`);return;}
  if(command==='data'&&positionals[1]==='upload'){console.log(`数据集已就绪：${result.machine}\n${result.dataset}@${result.version}\n训练只读路径：/data2/${result.dataset}\n可在 run 中使用 --data ${result.dataset}@${result.version}`);return;}
  if(command==='data'&&['upload-status','upload-discard'].includes(positionals[1])){console.log(`${result.state} · ${result.uploadId} · ${result.machine}${result.error?'\n'+result.error:''}${result.state==='READY'?'\n'+result.dataset+'@'+result.version+'\n训练只读路径：/data2/'+result.dataset:''}`);return;}
  if(command==='data'&&(positionals[1]==='unregister'||/^[a-f0-9]{64}$/.test(positionals[2]||''))){
    if(result.state==='UNREGISTERED')console.log(`${result.unregistered?'已注销所选本地数据集范围':'所选注册已不存在'}：${result.dataset}${result.version?'@'+result.version:''}${result.recoveryId?'\n恢复记录：'+result.recoveryId:''}`);
    else console.log(`${result.state==='UNREGISTERING'?'已受理注销，尚未完成':result.state} · ${result.operationId}${result.error?'\n'+result.error:''}\n查看：gpuctl data status ${result.operationId} --machine ${result.machine}`);
    return;
  }
  if(command==='run'){console.log(`已提交 ${result.id}\n${result.machine} · ${allocationLabel(result)} GPU · ${result.state}\n查看日志：gpuctl logs ${result.id}`);return;}
  if(command==='transfer'){
    if(result.transfers){console.log(result.transfers.map(transferText).join('\n')||'暂无传输。');if(result.nextCursor)console.log('下一页：gpuctl transfer list --cursor '+result.nextCursor);}
    else if(result.transferId)console.log(`传输 ${result.transferId} · ${result.state}\n${result.downloaded||result.dataset+'@'+result.version}`);
    else console.log(transferText(result));return;
  }
  if(command==='exec'){
    if(result.stdout)process.stdout.write(result.stdout);
    if(result.stderr)process.stderr.write(result.stderr);
    process.stderr.write(`\nHost command ${result.id} · ${result.machine} · ${result.state}${result.exitCode!==null&&result.exitCode!==undefined?' · exit '+result.exitCode:''}\n`);
    if(result.truncated?.stdout||result.truncated?.stderr)process.stderr.write('Output was truncated at 65536 bytes per stream.\n');
    if(!['SUCCEEDED','FAILED','CANCELED','TIMED_OUT'].includes(result.state))process.stderr.write(`Inspect: gpuctl exec status ${result.id} --machine ${result.machine}\nCancel: gpuctl exec cancel ${result.id} --machine ${result.machine}\n`);
    if(result.error)process.stderr.write(result.error+'\n');return;
  }
  if(command==='notes'){for(const n of result.notes)console.log(`${n.id} · ${n.author.username} · ${n.jobId||'非任务留言'}\n${n.body}\n`);if(!result.notes.length)console.log('暂无留言。');if(result.nextCursor)console.log('更多留言可通过 API before='+result.nextCursor+' 查询。');return;}
  if(command==='note'||command==='note-delete'){console.log(result.deleted?`留言 ${result.id} 已删除。`:`留言 ${result.note?.id||result.id} 已保存。`);return;}
  if(command==='priority'){console.log(`任务 ${result.id}：优先级 ${result.priority||'normal'}${result.priorityPending?'（等待节点确认）':''}`);return;}
  if(command==='notify'){console.log(`Telegram：${result.configured?'收件人已配置':'收件人尚未配置'} · ${result.degraded?'通知存储暂不可用':result.enabled?'通知已开启':'通知关闭'} · 待发 ${result.pending??'未知'} · 失败 ${result.failed??'未知'}`);return;}
  if(command==='logs'){process.stdout.write(result.text+(result.text.endsWith('\n')?'':'\n'));return;}
  if(command==='cancel'){console.log(`任务 ${result.id}：${result.state}${result.cancelRequested?'（已请求取消，等待节点确认）':''}`);return;}
  if(command==='upload'){console.log(`已上传 ${result.uploaded} 个文件到 ${result.machine} 的${result.project?'项目 '+result.project+' 草稿':'个人工作区'}。${result.skipped?'跳过 '+result.skipped+' 项。':''}`);return;}
  if(command==='download'){console.log(`已下载：${result.downloaded}（${result.bytes} 字节）`);return;}
  if(command==='jobs'){console.log(result.length?[...result].slice(-50).reverse().map(j=>`${j.id}  ${j.state}${j.preempted?'（让位中断，不会自动重跑）':''}\n  ${j.machine} · ${allocationLabel(j)} · ${j.name||'train'} · 优先级 ${['idle','normal','high'].includes(j.priority)?j.priority:'旧策略／未核验'}${j.schedulerState?' · 调度 '+j.schedulerState:''}${j.queueReason?'\n  排队原因：'+j.queueReason:''}\n  ${progressText(j.progress)}`).join('\n'):'暂无任务。');if(result.length>50)console.log('仅显示最近 50 条；完整记录：gpuctl jobs --json');return;}
  if(command==='files'){console.log(result.entries.map(f=>`${f.type==='directory'?'[目录]':'[文件]'} ${f.name}${f.type==='file'?'  '+f.size+' B':''}`).join('\n')||'目录为空。');return;}
  if(command==='maintenance'){
    const v=maintenanceVisible;
    if(result.version===1&&Object.hasOwn(result,'global')){
      console.log('维护状态 · revision '+result.revision);
      const entries=[...(result.global?[['全平台',result.global]]:[]),...Object.entries(result.machines)];
      console.log(entries.length?entries.map(([scope,entry])=>v(scope)+'：'+v(entry.reason)).join('\n'):'当前可见范围未设置维护。');
      console.log('维护只封锁新操作，不自动结束已有任务；恢复必须管理员明确操作。');return;
    }
    console.log('历史运维记录（只读；维护申请已停用）');
    if(result.items){console.log(result.items.map(r=>`${v(r.id)}  ${v(r.state)}${r.state==='PENDING'?'（未执行，不能再审批）':''}  v${r.revision}\n  ${v(r.machine)} · ${v(r.owner.username)} · ${v(r.title)}`).join('\n')||'暂无历史记录。');if(result.nextCursor)console.log('下一页：gpuctl maintenance list --cursor '+v(result.nextCursor));return;}
    const r=result;console.log(`${v(r.id)} · ${v(r.state)}${r.state==='PENDING'?'（未执行，不能再审批）':''} · v${r.revision}\n${v(r.machine)} · ${v(r.owner.username)} · ${v(r.title)}\n原因：${v(r.reason)}\n目录：${v(r.cwd)} · 超时 ${r.timeoutSec}s\n脚本 SHA256：${v(r.scriptSha256)}\n历史脚本（仅供查阅；不可见字符以 Unicode 转义显示）：\n${v(r.script,true)}`);
    if(r.decision?.reason)console.log('退回理由：'+v(r.decision.reason));if(r.error)console.log(v(r.error));
    if(r.result){console.log(`上次节点回执：${v(r.result.state)} · exit=${r.result.exitCode??'未确认'} · ${v(r.result.checkedAt)}`);process.stdout.write(v(r.result.stdout,true));process.stderr.write(v(r.result.stderr,true));if(r.result.truncated?.stdout||r.result.truncated?.stderr)console.log('\n输出已截断（每路最多 64 KiB）。');}
    return;
  }
  if(command==='users'){console.log(result.map(u=>`${u.username}  ${u.role==='admin'?'管理员':'普通用户'}  ${u.enabled?'启用':'暂停'}  总额度 ${u.total} 张\n  ${Object.entries(u.limits).map(([m,n])=>`${m}: ${n}`).join('，')||'尚未授权机器'}`).join('\n'));return;}
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===realpathSync(process.argv[1])){
  main().catch(error=>{console.error(wantsJSON?maintenanceJSON({ok:false,error:error.message}):`Error: ${maintenanceVisible(error.message)}`);process.exitCode=1;});
}
