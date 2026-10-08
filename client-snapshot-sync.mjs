import {mkdtemp,mkdir,lstat,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {DATA_CHUNK,dataPath,snapshotKey,scanLocalDataset,uploadDatasetSnapshot} from './client-data-upload.mjs';
const fail=message=>{throw Error(message);};
const runFile=promisify(execFile);
const utf8=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
async function copyGitBlob(args,env,entry,filename){
  // No checkout, archive, textconv or filters: stream exactly the fixed ODB blob.
  const child=spawn('git',[...args,'cat-file','blob',entry.oid],{env,stdio:['ignore','pipe','pipe']});
  let stderr='',bytes=0;const hash=createHash('sha256'),objectHash=createHash(entry.oid.length===64?'sha256':'sha1').update('blob '+entry.size+'\0');
  child.stderr.on('data',chunk=>{if(stderr.length<4096)stderr+=chunk.toString().slice(0,4096-stderr.length);});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>code===0?resolve():reject(Error('Cannot read fixed Git blob: '+(stderr.trim()||signal||code))));});
  const sizeCheck=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;hash.update(chunk);objectHash.update(chunk);done(bytes>entry.size?Error('Git blob size changed'):null,chunk);}});
  const copied=pipeline(child.stdout,sizeCheck,createWriteStream(filename,{flags:'wx',mode:0o600}));
  try{
    await Promise.all([exited,copied]);
    if(bytes!==entry.size||objectHash.digest('hex')!==entry.oid)fail('Fixed Git blob content or size changed');
    return hash.digest('hex');
  }catch(error){child.kill();await Promise.allSettled([exited,copied]);throw error;}
}
export async function gitSnapshot(directory,ref='HEAD',progress=()=>{}){
  if(!ref||ref.startsWith('-')||ref.includes('\0'))fail('Use a Git branch/tag/ref or commit');
  const args=['--no-replace-objects','--no-optional-locks','-c','core.fsmonitor=false','-c','core.attributesFile=','-C',directory],env={...process.env,GIT_NO_LAZY_FETCH:'1',GIT_ATTR_NOSYSTEM:'1'};
  const git=async(argv,input)=>{const result=runFile('git',[...args,...argv],{env,encoding:'buffer',maxBuffer:64*1024**2});if(input!==undefined){result.child.stdin.on('error',()=>{});result.child.stdin.end(input);}return utf8((await result).stdout);};
  // Even status may invoke clean/process filters. Disable configured commands
  // only for our subprocesses; do not run repository code or edit user config.
  const filters=await git(['config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|smudge|process|required)$']).catch(error=>{if(error.code===1)return '';throw error;});
  for(const key of filters.split('\0').filter(Boolean))args.push('-c',key+'='+(/\.required$/i.test(key)?'false':''));
  const clean=async()=>{if((await git(['status','--porcelain=v1','--untracked-files=all'])).trim())fail('Git sync requires a clean worktree, including untracked files. Commit selected code first.');};
  await clean();const commit=(await git(['rev-parse','--verify','--end-of-options',ref+'^{commit}'])).trim();
  if(!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(commit))fail('Git did not resolve a complete commit');
  const tree=(await git(['ls-tree','-r','-l','-z','--full-tree',commit])).split('\0').filter(Boolean),entries=[],directories=new Set();
  for(const line of tree){
    const match=/^(100644|100755) blob ([a-f0-9]+) +([0-9]+)\t(.+)$/.exec(line);
    if(!match)fail('Git snapshot does not support symlinks or submodules; sync ordinary data separately');
    const path=dataPath(match[4]),size=Number(match[3]);if(!Number.isSafeInteger(size)||size<0)fail('Git file byte counts must be exact nonnegative integers');
    entries.push({path,oid:match[2],size,executable:match[1]==='100755'});
    const parts=path.split('/');for(let i=1;i<parts.length;i++)directories.add(parts.slice(0,i).join('/'));
    if(entries.length+directories.size>500000)fail('Git snapshot exceeds 500,000 entries');
  }
  // --source reads attributes from the selected commit, not a newer worktree.
  // Local info/attributes takes precedence even with --source; never let it hide
  // an export exclusion. Global/system attributes are disabled command-locally.
  const infoAttributes=(await git(['rev-parse','--path-format=absolute','--git-path','info/attributes'])).trim();
  if(await lstat(infoAttributes).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))fail('Git sync refuses local info/attributes overrides; use a clean clone without local attribute overrides');
  let attributes;
  const attributePaths=[...[...directories].flatMap(path=>[path,path+'/']),...entries.map(entry=>entry.path)];
  try{attributes=(await git(['check-attr','--source='+commit,'-z','--stdin','export-ignore','export-subst'],attributePaths.join('\0')+(attributePaths.length?'\0':''))).split('\0');}
  catch(error){fail('Git sync requires Git with check-attr --source support to verify fixed-commit export rules: '+error.message);}
  for(let i=0;i+2<attributes.length;i+=3)if(!['unspecified','unset'].includes(attributes[i+2]))fail('Git sync cannot import '+attributes[i+1]+' rules from the fixed commit ('+attributes[i]+'); prepare an explicit sync commit without archive transformations');
  const temporary=await mkdtemp(join(tmpdir(),'gpuq-git-sync-')),code=join(temporary,'code');
  try{
    await mkdir(code);
    // ASCII cache names avoid host tar decoding, case folding, reserved names
    // and filesystem Unicode normalization. Only the manifest carries Git paths.
    const source=new Map();
    for(const [index,entry] of entries.entries()){const local=String(index);entry.sha256=await copyGitBlob(args,env,entry,join(code,local));source.set(local,entry);}
    const scan=await scanLocalDataset(code,progress),manifest=JSON.parse(scan.manifest);
    if(manifest.files.length!==entries.length||manifest.directories.length)fail('Fixed Git cache entries changed');
    const localFiles=new Map();
    for(const entry of manifest.files){const fixed=source.get(entry.path);if(!fixed||entry.size!==fixed.size||entry.sha256!==fixed.sha256)fail('Fixed Git cache content changed');localFiles.set(fixed.path,{...entry});entry.path=fixed.path;entry.executable=fixed.executable;}
    manifest.directories=[...directories].sort();manifest.files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const raw=Buffer.from(JSON.stringify(manifest));if(raw.length>64*1024**2)fail('Git snapshot manifest exceeds 64 MiB');
    const openEntry=scan.openEntry;scan.openEntry=entry=>openEntry(localFiles.get(entry.path));
    scan.manifest=raw;scan.manifestSha256=createHash('sha256').update(raw).digest('hex');scan.files=manifest.files;scan.entries=manifest.files.length+manifest.directories.length;
    const verify=scan.verify;scan.verify=async()=>{await verify();await clean();if((await git(['rev-parse','--verify','--end-of-options',ref+'^{commit}'])).trim()!==commit)fail('Git ref changed; sync was not finalized');};
    return {...scan,source:{kind:'git',commit},cleanup:()=>rm(temporary,{recursive:true,force:true})};
  }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
}
export async function remoteSnapshot(call,kind,reference,progress){
  const request=async(action,args={})=>(await call(kind+'.snapshot.'+action,{...reference,...args})).result;
  const info=await request('info');if(info.state!=='READY'||!Number.isSafeInteger(info.manifestBytes)||info.manifestBytes<1||info.manifestBytes>64*DATA_CHUNK||!/^[a-f0-9]{64}$/.test(info.manifestSha256))fail('Source did not confirm a complete fixed snapshot');
  const chunks=[];let offset=0;while(offset<info.manifestBytes){const response=await request('manifest',{offset}),bytes=Buffer.from(response.data,'base64');if(!bytes.length||bytes.length>DATA_CHUNK||response.offset!==offset+bytes.length||response.size!==info.manifestBytes)fail('Source manifest offset changed');chunks.push(bytes);offset+=bytes.length;progress('MANIFEST',{bytes:offset,totalBytes:info.manifestBytes});}
  const manifest=Buffer.concat(chunks);if(manifest.length!==info.manifestBytes||createHash('sha256').update(manifest).digest('hex')!==info.manifestSha256)fail('Source manifest SHA256 mismatch');
  const parsed=JSON.parse(manifest);if(parsed.schema!==1||!Array.isArray(parsed.files)||!Array.isArray(parsed.directories)||parsed.files.length+parsed.directories.length!==info.entries)fail('Invalid source manifest');
  for(const file of parsed.files)if(dataPath(file.path)!==file.path||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256))fail('Invalid fixed source file');
  const verify=async()=>{const next=await request('info');if(next.state!=='READY'||next.manifestSha256!==info.manifestSha256)fail('Source readiness changed; do not finalize sync');};
  const openEntry=async entry=>({read:async offset=>{const result=await request('get',{path:entry.path,offset}),bytes=Buffer.from(result.data,'base64');if(bytes.length>DATA_CHUNK||result.offset!==offset+bytes.length||result.size!==entry.size)fail('Source file changed or returned a different offset');return bytes;},verify:async()=>{},close:async()=>{}});
  return {...info,manifest,files:parsed.files,verify,openEntry,cleanup:async()=>{},...(kind==='projects'?{source:{kind:'release',...reference}}:{})};
}
export async function syncCodeSnapshot(call,{machine,project,key,scan,progress}){
  const request=async(action,args={})=>(await call('projects.sync.'+action,{machine,project,key,...args})).result;
  let state=await request('begin',{manifestBytes:scan.manifest.length,manifestSha256:scan.manifestSha256,totalBytes:scan.totalBytes,entries:scan.entries,source:scan.source});
  if(state.state==='CODE_READY')return {...state,machine};
  if(state.state==='RECEIVING_MANIFEST'){
    let offset=state.manifestOffset;if(!Number.isSafeInteger(offset)||offset<0||offset>scan.manifest.length)fail('Invalid code manifest resume offset');
    while(offset<scan.manifest.length){const bytes=scan.manifest.subarray(offset,offset+DATA_CHUNK),out=await request('manifest',{offset,data:bytes.toString('base64')});if(out.offset!==offset+bytes.length)fail('Target did not confirm manifest chunk');offset=out.offset;}
    state=await request('seal');
  }
  if(state.state!=='COPYING')fail('Target code sync state is unconfirmed; repeat the same command');
  let transferred=0;
  for(const entry of scan.files){const {file:remote}=await request('status',{path:entry.path});if(!remote||remote.size!==entry.size||remote.sha256!==entry.sha256||!Number.isSafeInteger(remote.offset)||remote.offset<0||remote.offset>entry.size)fail('Target code resume identity differs');
    if(!remote.complete){const file=await scan.openEntry(entry);try{let offset=remote.offset;do{const bytes=await file.read(offset),out=await request('chunk',{path:entry.path,offset,data:bytes.toString('base64')});if(out.offset!==offset+bytes.length||!bytes.length&&offset<entry.size)fail('Target did not confirm code chunk');offset=out.offset;if(offset===entry.size&&out.complete!==true)fail('Target did not verify complete code file');progress('COPYING',{path:entry.path,bytes:transferred+offset,totalBytes:scan.totalBytes});}while(offset<entry.size);await file.verify();}finally{await file.close();}}
    transferred+=entry.size;
  }
  await scan.verify();const out=await request('finish');if(out.state!=='CODE_READY')fail('Target did not confirm complete code snapshot');return {...out,machine};
}

export async function runManualSync(call,{options,positionals,training,machines,userId}){
  const state={machines},session={principal:{userId}},machineName=value=>{const exact=machines.find(m=>m.id===value);if(exact)return exact.id;const short=machines.filter(m=>m.id.endsWith('-'+value));return short.length===1?short[0].id:value;};
  const projectSlug=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(value))fail('Project must use a new lowercase project slug');return value;};
  if(['status','cancel'].includes(positionals[1])){
    const mode=positionals[1],allowed=['machines','datasets','url','session-file','json','to','project'];
    if(training.length||options.machines.length||options.datasets.length||positionals.length!==3||Object.keys(options).some(k=>!allowed.includes(k)))fail('Usage: sync status|cancel ORIGINAL_UUID --to SERVER --project PROJECT');
    const machine=machineName(options.to||fail('Select target explicitly with --to SERVER')),project=projectSlug(options.project),key=positionals[2];
    if(machine==='auto'||!machines.some(m=>m.id===machine))fail('Target is not an authorized explicit server');
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key||''))fail('Use the original complete sync UUID');
    const reference={machine,project,key},before=(await call('projects.sync.status',reference)).result;
    if(mode==='status')return {...before,machine};
    if(before.cancelProtocol!==1||before.project!==project||before.key!==key||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(before.snapshotId||'')||!/^[a-f0-9]{64}$/.test(before.revision||'')||!/^[a-f0-9]{64}$/.test(before.manifestSha256||'')||!before.source)fail('Node has no confirmed cancellation protocol; retain this UUID');
    if(before.state==='CANCELED'&&before.preservesBytes===true)return {...before,machine};
    if(!['RECEIVING_MANIFEST','COPYING'].includes(before.state))fail('Only an unfinished code synchronization can be canceled');
    const pinned={...reference,...Object.fromEntries(['snapshotId','source','manifestSha256','revision'].map(k=>[k,before[k]]))};
    const sameSource=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===Object.keys(before.source).length&&Object.keys(before.source).every(k=>Object.hasOwn(value,k)&&value[k]===before.source[k]);
    const confirmed=row=>row?.state==='CANCELED'&&row.preservesBytes===true&&row.cancelProtocol===1&&row.key===key&&row.project===project&&['snapshotId','manifestSha256','revision'].every(k=>row[k]===before[k])&&sameSource(row.source);
    let result;
    try{result=(await call('projects.sync.cancel',pinned)).result;}
    catch(error){
      // Ambiguous acknowledgement: observe only this UUID, never resend the
      // mutation or mint a replacement key. Unknown remains an error.
      let observed;try{observed=(await call('projects.sync.status',reference)).result;}catch{}
      if(!confirmed(observed))throw error;result=observed;
    }
    if(!confirmed(result))fail('Cancellation is unconfirmed; inspect the original UUID with sync status');
    return {...result,machine};
  }
  let result;
      const mode=positionals[1],common=['machines','datasets','url','session-file','json','to','from','dry-run','key'];
      const allowed=mode==='git'?[...common,'project','ref']:mode==='code'?[...common,'project','target-project','release']:mode==='data'?[...common,'name']:[];
      if(!['git','code','data'].includes(mode)||training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!allowed.includes(k))||positionals.length!==(mode==='code'?2:3))fail('Usage: sync git LOCAL_REPO --to SERVER --project NEW [--ref HEAD] | sync code --from SERVER --to SERVER --project SOURCE --target-project NEW --release HASH | sync data NAME@VERSION --from SERVER --to SERVER --name NAME; add --dry-run to preview');
      const target=machineName(options.to||fail('Select target explicitly with --to SERVER'));
      if(!state.machines.some(m=>m.id===target)||target==='auto')fail('Target is not an authorized explicit server');
      const source=mode==='git'?null:machineName(options.from||fail('Select source explicitly with --from SERVER'));
      if(source&&(!state.machines.some(m=>m.id===source)||source===target||source==='auto'))fail('Select two different authorized source/target servers');
      if(mode==='git'&&options.from)fail('Git sync source is the local repository, not --from');
      const project=mode==='code'?projectSlug(options['target-project']):mode==='git'?projectSlug(options.project):null;
      let last=0;const progress=(phase,value)=>{if(Date.now()-last>1000||phase==='HANDLE'){last=Date.now();process.stderr.write(`${phase}${value.path?' · '+value.path:''}${value.bytes!==undefined?' · '+value.bytes+' / '+(value.totalBytes??'?')+' bytes':''}${value.uploadId?' · '+value.uploadId:''}\n`);}};
      let scan;
      try{
        if(mode==='git')scan=await gitSnapshot(positionals[2],options.ref||'HEAD',progress);
        else if(mode==='code'){projectSlug(options.project);if(!options.release)fail('Code sync requires --release FULL_HASH');scan=await remoteSnapshot(call,'projects',{machine:source,project:options.project,release:options.release},progress);}
        else{const [dataset,version,...extra]=positionals[2].split('@');if(extra.length||!dataset||!/^[a-f0-9]{64}$/.test(version||''))fail('Data sync requires NAME@FULL_VERSION_HASH');if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(options.name||''))fail('Select the target private dataset name using --name NAME (1–40 ASCII characters)');scan=await remoteSnapshot(call,'datasets',{machine:source,dataset,version},progress);scan.expectedVersion=version;}
        const key=options.key||snapshotKey([session.principal.userId,mode,target,project||options.name,scan.manifestSha256]);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key))fail('--key must be a UUID');
        let resume=null;
        if(project){const catalog=(await call('projects.list',{machine:target})).result;if(catalog.projects.some(p=>p.project===project)){resume=(await call('projects.sync.status',{machine:target,project,key})).result;if(resume.manifestSha256!==scan.manifestSha256)fail('Existing destination does not belong to this fixed snapshot');}}
        else await call('datasets.list',{machine:target});
        const plan={mode,source:scan.source||{machine:source,dataset:positionals[2]},target,project,name:options.name||null,manifestSha256:scan.manifestSha256,bytes:scan.totalBytes,entries:scan.entries,key,resume:resume?.state||null};
        process.stderr.write(`Sync plan: ${mode} · ${source||'local Git'} → ${target} · ${scan.totalBytes} bytes · ${scan.entries} entries\nFixed source: ${scan.source?.commit||scan.source?.release||positionals[2]}\nSync key: ${key}\n`);
        if(options['dry-run'])result={...plan,state:'PREVIEW',changes:false};
        else if(project)result=await syncCodeSnapshot(call,{machine:target,project,key,scan,progress});
        else{const keyStore={get:()=>key,set:async()=>{fail('This upload was explicitly discarded; rerun with a new --key after review');}};result=await uploadDatasetSnapshot(call,{machine:target,name:options.name,userId:session.principal.userId,scan,progress,keyStore});if(result.version!==scan.expectedVersion)fail('Target READY dataset content version differs from the source');}
      }finally{await scan?.cleanup();}

  return result;
}
