import {createJobDiagnostics} from './job-diagnostics-ui.js';
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const terminal=new Set(['SUCCEEDED','FAILED','CANCELED']);
const hashPattern=/^[a-f0-9]{64}$/;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const priorities={normal:{label:'普通',description:'默认排队，不会因新任务自动中断。'},idle:{label:'最低 · 可中断',description:'只适合可丢弃或自行保存进度的任务；让位时结束进程，已写入的输出保留。'},high:{label:'高 · 管理员',description:'优先排队，可让最低任务让位；不自动中断普通任务。'}};
export function priorityLabel(value){return priorities[value]?.label||(Number.isInteger(value)&&value>=0&&value<=4?`P${value}（原队列）`:'未标注');}
export function priorityOptions(admin=false,selected='normal'){return ['normal','idle',...(admin?['high']:[])].map(value=>`<option value="${value}" ${value===selected?'selected':''}>${priorities[value].label}</option>`).join('');}
export function trainingPriority(value,admin=false){if(!Object.hasOwn(priorities,value)||value==='high'&&!admin)throw Error('请选择允许的任务优先级；高优先级仅供管理员使用。');return value;}
export function priorityDescription(value){return priorities[value]?.description||'优先级尚未确认。';}
const rankLabels=['P0 最低','P1 低','P2 普通','P3 较高','P4 最高'];
export function priorityRankOptions(selected){return ['idle','P1','normal','P3','high'].map((value,i)=>`<option value="${value}" ${value===selected?'selected':''}>${rankLabels[i]}</option>`).join('');}
export function priorityRankValue(value){if(!['idle','P1','normal','P3','high','P0','P2','P4'].includes(value))throw Error('请选择 P0–P4 排队等级。');return value;}
export function priorityRankLabel(job){return job.priority!=null&&Number.isInteger(job.schedulerPriority)&&job.schedulerPriority>=0&&job.schedulerPriority<=4?rankLabels[job.schedulerPriority]:priorityLabel(job.priority);}
export function schedulingContractLabel(policy){if(!policy)return '让位/恢复策略未确认';return `${({never:'不让位',now:'允许立即让位',save:'保存后让位',legacy:'旧版让位策略'})[policy.yield_policy]||'让位方式未知'} · ${policy.restart_policy==='on-preempt'?'被抢占后重新排队':policy.restart_policy==='never'?'被抢占后不重排':'重启方式未知'}`;}
export function sampleTime(value){
  const date=typeof value==='number'?new Date(value*1000):new Date(value);
  return value!==null&&value!==undefined&&value!==''&&Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'未提供';
}
export function taskStateLabel(job){
  if(job.state==='CANCELED'&&job.preempted===true)return '让位结束';
  return {SUBMITTING:'提交中',PENDING:'排队中',QUEUED:'排队中',STARTING:'启动中',RUNNING:'运行中',UNKNOWN:'状态待核对',SUCCEEDED:'已完成',FAILED:'失败',CANCELED:'已取消',PREEMPTING:'正在让位',PREEMPTED:'让位结束'}[job.state]||job.state||'状态未知';
}
export const validProject=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(value);
export function projectStatusText(info,hasTerminal=false){
  const labels={DRAFT:'代码草稿',READY:'已有就绪版本',PUBLISHING:'正在发布',FAILED:'发布失败'};
  const parts=[labels[info?.state]||'项目状态未确认'];
  if(info)parts.push(info.environmentMode==='isolated'?'环境：完全隔离（不继承基础包）':info.environmentMode==='shared'?'环境：共享基础包':'环境：共享基础包（旧默认）');
  if(info?.error)parts.push(String(info.error));
  const progress=info?.progress,phases={scanning:'扫描',copying:'复制',verifying:'校验',publishing:'写入版本',complete:'完成'};
  if(progress&&['PUBLISHING','FAILED'].includes(info.state)){
    const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
    const entries=count(progress.completedEntries),total=count(progress.totalEntries),bytes=count(progress.completedBytes),totalBytes=count(progress.totalBytes);
    parts.push(`${phases[progress.phase]||'处理中'}${entries===null?'':`：${entries}${total===null?'':` / ${total}`} 项`}${bytes===null?'':`，${bytes}${totalBytes===null?'':` / ${totalBytes}`} B`}`);
  }
  const detail=info?.errorDetails;
  if(detail&&info.state==='FAILED'){
    for(const [key,label] of [['path','位置'],['kind','类型'],['mode','权限'],['links','链接数'],['remediation','处理建议']])if(detail[key]!==undefined)parts.push(label+'：'+String(detail[key]));
  }
  if(hasTerminal)parts.push('先结束项目开发终端，再发布。');
  return parts.join(' · ');
}
export function readyReleases(project){return [...new Map((Array.isArray(project?.releases)?project.releases:[]).filter(item=>item?.state==='READY'&&typeof item.release==='string'&&hashPattern.test(item.release)).map(item=>[item.release,item])).values()];}
export function trainingProject(project,release){
  if(!project)return {};
  if(!validProject(project.project)||!readyReleases(project).some(item=>item.release===release))throw Error('请先发布项目，再选择一个已就绪的固定版本。');
  return {project:project.project,release};
}
export function datasetReferences(value){return String(value||'').trim().split(/\s+/).filter(Boolean).map(ref=>{
  const [dataset,version,...extra]=ref.split('@');
  if(extra.length||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dataset||'')||!hashPattern.test(version||''))throw Error('从数据集页面选择完整的名称@版本。');
  return {dataset,version};
});}
function base64(bytes){let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);}
export async function uploadProjectFile(file,context,send,progress=()=>{}){
  if(!validProject(context.project)||context.area!=='code')throw Error('项目只能上传到代码草稿。');
  if(!Number.isSafeInteger(file.size)||file.size<0||file.size>100*1024*1024)throw Error('网页单文件上限 100 MiB；大文件请用 CLI。');
  const contents=await file.arrayBuffer();if(contents.byteLength!==file.size)throw Error('文件读取长度不一致，请重新选择。');
  const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',contents))].map(value=>value.toString(16).padStart(2,'0')).join('');
  const uploadId=crypto.randomUUID();let offset=0;
  do{const bytes=new Uint8Array(contents,offset,Math.min(1048576,file.size-offset)),final=offset+bytes.length===file.size;
    const receipt=await send({...context,uploadId,totalSize:file.size,sha256,offset,data:base64(bytes),final});
    if(final&&(receipt?.complete!==true||receipt.size!==file.size||receipt.sha256!==sha256))throw Error('服务器尚未确认完整文件及校验和；请重新上传此文件，确认成功后再发布。');
    offset+=bytes.length;progress(offset,file.size);
  }while(offset<file.size);
}

export function executionUI(store,refresh,toast){
  let section,log,actor=null,submitKey=crypto.randomUUID(),machine='',project='',catalog=[],catalogError='',projectBusy=false,operationBusy=false;
  let epoch=0,pollTimer=null,pollCount=0,terminalSessions=[],machineIdentity='';
  const diagnostics=createJobDiagnostics(store,()=>log,toast);
  const call=(operation,args)=>store.call(operation,args),query=selector=>section?.querySelector(selector);
  const context=()=>({machine,...(project?{project}:{})}),currentProject=()=>catalog.find(item=>item.project===project);
  const currentToken=()=>JSON.stringify([actor,machine,project,epoch]),ownJobs=()=>store.jobs.filter(job=>job.userId===store.principal?.userId);
  const priorityAvailable=()=>store.data?.execution?.priorityCapabilities?.[machine]===true;
  const enabled=()=>!!store.principal&&store.data?.executionEnabled===true&&(store.data?.machines||[]).some(item=>item.id===machine);
  const isVisible=()=>!document.hidden&&!section?.closest('[data-page]')?.hidden;
  const hasTerminal=()=>terminalSessions.some(item=>item.machine===machine&&item.project===project&&item.userId===actor);
  const status=(text,error=false)=>{const element=query('#project-status');if(element){element.textContent=text;element.classList.toggle('form-error',error);}};
  const stopPolling=()=>{clearTimeout(pollTimer);pollTimer=null;};
  function notifyContext(){document.dispatchEvent(new CustomEvent('gpuq-workspace-context',{detail:{userId:actor,...context()}}));}
  function assertContext(){if(!enabled())throw Error('先在工作台顶部选择一台已授权服务器。');if(project&&!currentProject())throw Error('项目状态尚未读取，请刷新后再试。');return context();}
  function updateControls(){
    if(!section||!actor)return;
    const available=enabled(),locked=operationBusy||projectBusy,info=currentProject(),publishing=info?.state==='PUBLISHING';
    for(const name of ['workspace-machine','workspace-project'])query(`[name=${name}]`).disabled=locked||(name==='workspace-project'&&!available);
    query('#projects-refresh').disabled=!available||locked;query('#project-create-form [type=submit]').disabled=!available||locked;
    query('#project-publish').disabled=!available||!project||!info||locked||publishing||hasTerminal()||!!catalogError;
    query('#project-terminal-stop').hidden=!hasTerminal();query('#project-terminal-stop').disabled=locked;
    const host=query('[name=terminal-host]');host.disabled=!!project||locked;host.closest('label').hidden=store.principal?.role!=='admin';if(project)host.checked=false;
    query('#terminal-open').disabled=!available||locked||publishing;
    const release=query('[name=release]');release.disabled=!project||locked||!readyReleases(info).length;
    const priority=query('[name=priority]');priority.disabled=!available||locked;
    for(const option of priority.options){option.disabled=option.value!=='normal'&&!priorityAvailable();if(option.value==='normal')option.textContent=machine&&!priorityAvailable()?'默认（旧策略未确认）':'普通';}
    query('#priority-note').textContent=(!machine?'选择服务器后确认优先级能力。':!priorityAvailable()?'这台服务器尚未确认支持优先级控制。':'')+' '+(machine&&!priorityAvailable()&&priority.value==='normal'?'暂按服务器原有策略提交。':priorityDescription(priority.value));
    query('#priority-note').classList.toggle('priority-warning',priority.value==='idle'||priority.value!=='normal'&&!priorityAvailable());
    query('#train-form [type=submit]').disabled=!available||locked||(priority.value!=='normal'&&!priorityAvailable())||(!!project&&(!!catalogError||!readyReleases(info).some(item=>item.release===release.value)));
    const output=project&&query('[name=file-area]').value==='output';
    for(const id of ['workspace-list','workspace-download'])query('#'+id).disabled=!available||locked;
    query('#workspace-upload').disabled=!available||locked||output||publishing;query('[name=files]').disabled=!available||locked||output||publishing;
    query('[name=file-area]').disabled=!project||locked;query('.output-run-fields').hidden=!output;query('#project-release-field').hidden=!project;query('#project-detail').hidden=!project;
    query('#workspace-mode-note').textContent=project?'代码草稿在 /workspace；项目环境在 /opt/project-env。发布后，训练读取固定只读版本，每项任务写入自己的 /outputs。':'个人工作区路径为 /workspace。终端、文件和训练共用此目录；新实验可单独创建项目。';
    query('#terminal-mode-note').textContent=project?'项目开发终端不分配 GPU。发布前请结束终端；断开连接不会结束会话。':'个人开发终端不分配 GPU。训练请通过下面的任务入口提交。';
  }
  function renderProject(){
    const select=query('[name=workspace-project]'),options='<option value="">个人工作区</option>'+catalog.filter(item=>validProject(item.project)).map(item=>`<option value="${escape(item.project)}">${escape(item.project)}</option>`).join('');if(select.innerHTML!==options)select.innerHTML=options;select.value=project;
    const info=currentProject(),releases=readyReleases(info),release=query('[name=release]'),previous=release.value;
    const missingPrevious=hashPattern.test(previous)&&!releases.some(item=>item.release===previous);
    const choices=(missingPrevious?`<option value="${previous}" disabled>${previous.slice(0,12)}… · 原选版本暂不可用</option>`:'')+releases.map(item=>`<option value="${item.release}">${item.release.slice(0,12)}… · 已就绪</option>`).join('');
    const releaseHTML=choices||'<option value="">尚无已发布版本</option>';if(release.innerHTML!==releaseHTML)release.innerHTML=releaseHTML;
    release.value=missingPrevious||releases.some(item=>item.release===previous)?previous:releases.some(item=>item.release===info?.latestReadyRelease)?info.latestReadyRelease:(releases[0]?.release||'');
    query('#release-full').textContent=release.value||'发布成功后才可提交项目训练。';query('#release-full').title=release.value;
    if(catalogError)status(catalogError,true);
    else if(project)status(projectStatusText(info,hasTerminal()),info?.state==='FAILED');
    else status(machine?'可直接使用个人工作区，或选择、创建独立项目。':'先选择服务器；项目、终端、文件和训练会跟随此选择。');
    renderRuns();updateControls();armPolling();
  }
  function renderRuns(){
    const select=query('[name=file-run]');if(!select)return;const previous=select.value,jobs=ownJobs().filter(job=>job.machine===machine&&job.project===project);
    select.innerHTML='<option value="">选择任务，或输入任务 ID</option>'+jobs.map(job=>`<option value="${escape(job.id)}">${escape(job.name)} · ${escape(job.id.slice(0,8))} · ${escape(job.state)}</option>`).join('');
    if(jobs.some(job=>job.id===previous))select.value=previous;
  }
  function clearFileContext(){query('[name=file-path]').value='.';query('[name=file-area]').value='code';query('[name=file-run-id]').value='';query('[name=file-run]').value='';query('[name=files]').value='';query('#workspace-result').textContent='仅操作当前服务器、当前工作区。代码上传失败后，可重新上传同一路径；未完成的上传会阻止发布。';}
  function syncMachineFields(){for(const name of ['workspace-machine','machine','terminal-machine','file-machine'])query(`[name=${name}]`).value=machine;const selected=(store.data?.machines||[]).find(item=>item.id===machine);query('[name=cards]').max=String(selected?.cards||1);}
  async function selectMachine(value){
    if(value===machine)return;machine=(store.data?.machines||[]).some(item=>item.id===value)?value:'';project='';catalog=[];catalogError='';epoch++;projectBusy=false;stopPolling();pollCount=0;
    query('[name=release]').value='';syncMachineFields();clearFileContext();renderProject();notifyContext();submitKey=crypto.randomUUID();if(machine)await loadProjects();
  }
  async function selectProject(value){
    if(value&&!catalog.some(item=>item.project===value)){toast('请刷新项目列表后再选择。');return;}
    if(value===project){if(project)await loadProjectStatus();return;}
    project=value;epoch++;projectBusy=false;catalogError='';stopPolling();pollCount=0;query('[name=release]').value='';clearFileContext();renderProject();notifyContext();submitKey=crypto.randomUUID();if(project)await loadProjectStatus();
  }
  async function loadProjects(){
    if(!enabled()||projectBusy||operationBusy)return;const token=currentToken(),selected=machine,requestEpoch=epoch,requestActor=actor;projectBusy=true;updateControls();status('正在读取这台服务器的项目…');
    try{const result=await call('projects.list',{machine:selected});if(token!==currentToken())return;
      catalog=Array.isArray(result.projects)?result.projects.filter(item=>validProject(item?.project)):[];catalogError='';
      if(project&&!catalog.some(item=>item.project===project)){project='';clearFileContext();notifyContext();}
    }catch(error){if(token===currentToken())catalogError=error.message;}
    finally{if(epoch===requestEpoch&&actor===requestActor&&selected===machine){projectBusy=false;renderProject();}}
  }
  async function loadProjectStatus(poll=false){
    if(!project||!enabled()||projectBusy||operationBusy)return;const token=currentToken(),target=context();projectBusy=true;updateControls();
    try{const result=await call('projects.status',target);if(token!==currentToken())return;if(result.project!==project)throw Error('项目返回身份不匹配。');catalog=catalog.map(item=>item.project===project?result:item);catalogError='';}
    catch(error){if(token===currentToken()){catalogError=error.message;stopPolling();}}
    finally{if(token===currentToken()){projectBusy=false;if(!poll)pollCount=0;renderProject();}}
  }
  function armPolling(){stopPolling();if(!isVisible()||projectBusy||operationBusy||catalogError||currentProject()?.state!=='PUBLISHING'||pollCount>=60)return;pollTimer=setTimeout(()=>{pollTimer=null;if(isVisible()){pollCount++;loadProjectStatus(true);}},5000);}
  async function guarded(button,fn){if(operationBusy)return;operationBusy=true;button.disabled=true;updateControls();try{await fn();}catch(error){toast(error.message);status(error.message,true);}finally{operationBusy=false;if(button.isConnected)button.disabled=false;updateControls();armPolling();}}
  function fileContext(){const target=assertContext();if(!project)return target;const area=query('[name=file-area]').value;if(area==='code')return {...target,area};const runId=query('[name=file-run-id]').value.trim();if(!uuidPattern.test(runId))throw Error('请选择本项目任务，或输入完整任务 ID。');return {...target,area:'output',runId};}
  async function listFiles(){const target=fileContext(),path=query('[name=file-path]').value||'.';const result=await call('files.list',{...target,path});query('#workspace-result').textContent=result.entries.map(file=>`${file.type==='directory'?'[目录]':'[文件]'} ${file.name}  ${file.type==='file'?file.size+' B':''}`).join('\n')||'目录为空';}
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.useMachine&&section&&actor)queueMicrotask(()=>selectMachine(button.dataset.useMachine).catch(error=>toast(error.message)));
    if(button.dataset.jobLogs)guarded(button,()=>diagnostics.openLogs(button.dataset.jobLogs));
    if(button.dataset.jobCancel&&window.confirm('取消这个训练任务？已保存的文件保留，确认停止后才释放额度。'))guarded(button,async()=>{await call('jobs.cancel',{jobId:button.dataset.jobCancel});refresh();toast('已请求取消；等待 GPUQ 确认释放。');});
    if(button.dataset.jobPrioritySave)guarded(button,async()=>{
      if(store.principal?.role!=='admin')throw Error('只有管理员可以调整排队任务优先级。');
      const jobId=button.dataset.jobPrioritySave,job=store.jobs.find(item=>item.id===jobId),control=button.closest('[data-priority-editor]')?.querySelector('select');
      if(!job||!canEditPriority(job,true)||!control)throw Error('任务已不在可调整的队列状态，请刷新后核对。');
      const priority=priorityRankValue(control.value);if(priority===job.priority){toast('优先级未改变。');return;}
      await call('jobs.priority',{jobId,priority,expectedPriority:control.dataset.originalPriority});control.dataset.originalPriority=priority;refresh();toast('已请求调整优先级；以下次调度核对结果为准。');
    });
    if(button.id==='close-job-log')log.close();
    if(button.id==='projects-refresh'){pollCount=0;loadProjects();}
    if(button.id==='project-publish')guarded(button,async()=>{const target=assertContext();if(!project)throw Error('先选择项目。');if(hasTerminal())throw Error('请先结束项目开发终端；断开连接不等于结束。');const result=await call('projects.publish',target);if(result.project!==project)throw Error('项目返回身份不匹配。');catalog=catalog.map(item=>item.project===project?result:item);catalogError='';pollCount=0;renderProject();toast(result.state==='READY'?'项目已发布。训练使用选定的固定版本。':'已开始发布；可稍后刷新，不会自动切换已选版本。');});
    if(button.id==='workspace-list')guarded(button,listFiles);
    if(button.id==='workspace-upload')guarded(button,async()=>{
      const target=fileContext(),dir=query('[name=file-path]').value||'.',files=[...query('[name=files]').files];if(target.area==='output')throw Error('任务输出只支持查看和下载。');if(!files.length)throw Error('先选择文件。');
      for(const file of files){const path=dir==='.'?file.name:dir+'/'+file.name,progress=offset=>{query('#workspace-result').textContent=`正在上传 ${file.name}：${offset} / ${file.size} B`;};
        if(target.project)await uploadProjectFile(file,{...target,path},args=>call('files.put',args),progress);
        else{let offset=0;do{const bytes=new Uint8Array(await file.slice(offset,offset+1048576).arrayBuffer());await call('files.put',{...target,path,offset,truncate:offset===0,data:base64(bytes)});offset+=bytes.length;progress(offset);}while(offset<file.size);}}
      query('#workspace-result').textContent=`已上传 ${files.length} 个文件${project?'到项目代码草稿；发布后才能用于训练。':'。'}`;renderProject();toast('文件上传完成。');
    });
    if(button.id==='workspace-download')guarded(button,async()=>{
      const target=fileContext(),path=query('[name=file-path]').value;if(!path||path==='.')throw Error('请填入要下载的文件相对路径。');let offset=0;const chunks=[];
      while(true){const result=await call('files.get',{...target,path,offset}),bytes=Uint8Array.from(atob(result.data),char=>char.charCodeAt(0));chunks.push(bytes);offset+=bytes.length;if(offset>100*1024*1024)throw Error('超过 100 MiB，请用 CLI 下载大文件。');if(result.eof)break;if(!bytes.length)throw Error('下载没有继续返回数据，请重试。');}
      const url=URL.createObjectURL(new Blob(chunks)),anchor=document.createElement('a');anchor.href=url;anchor.download=path.split('/').pop();anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    if(button.dataset.jobOutput){const job=ownJobs().find(item=>item.id===button.dataset.jobOutput);if(!job?.project){toast('只能打开自己的项目任务输出。');return;}(async()=>{await selectMachine(job.machine);await selectProject(job.project);if(machine!==job.machine||project!==job.project)throw Error('无法确认任务对应的项目，请先刷新项目列表。');query('[name=file-area]').value='output';query('[name=file-path]').value='.';query('[name=file-run-id]').value=job.id;renderRuns();query('[name=file-run]').value=job.id;query('#workspace-files').open=true;updateControls();await guarded(button,listFiles);})().catch(error=>toast(error.message));}
  });
  document.addEventListener('submit',event=>{
    if(event.target.id==='project-create-form'){event.preventDefault();const slug=query('[name=new-project]').value.trim();guarded(event.target.querySelector('[type=submit]'),async()=>{
      assertContext();if(!validProject(slug))throw Error('项目名需小写字母开头，使用字母、数字、下划线或短横线，最多 48 位。');
      const environmentMode=query('[name=environment-mode]').value;if(!['shared','isolated'].includes(environmentMode))throw Error('请选择项目环境模式。');
      const result=await call('projects.create',{machine,project:slug,environmentMode});if(result.project!==slug)throw Error('项目返回身份不匹配。');if(environmentMode==='isolated'&&result.environmentMode!=='isolated')throw Error('节点未确认完全隔离模式；请升级节点后核对项目，不要开始安装环境。');catalog=[...catalog.filter(item=>item.project!==slug),result];project=slug;epoch++;query('[name=release]').value='';clearFileContext();catalogError='';renderProject();notifyContext();query('[name=new-project]').value='';query('#project-create').open=false;submitKey=crypto.randomUUID();toast('项目已创建。上传代码、安装项目环境，然后发布。');
    });return;}
    if(event.target.id!=='train-form')return;event.preventDefault();const form=new FormData(event.target);
    guarded(event.target.querySelector('[type=submit]'),async()=>{const target=assertContext();if(form.get('machine')!==machine)throw Error('服务器选择已改变，请核对工作台顶部后再提交。');const datasets=datasetReferences(form.get('datasets'));
      const priority=trainingPriority(form.get('priority'),store.principal?.role==='admin');if(priority!=='normal'&&!priorityAvailable())throw Error('尚未确认这台服务器支持优先级控制，请刷新核对或明确选择普通优先级。');
      await call('jobs.submit',{machine:target.machine,cards:Number(form.get('cards')),minVramGiB:Number(form.get('memory')),name:form.get('name')||'train',...(priorityAvailable()?{priority}:{}),argv:['/bin/bash','-c',String(form.get('command'))],key:submitKey,...trainingProject(project?currentProject():null,form.get('release')),...(datasets.length?{datasets}:{})});submitKey=crypto.randomUUID();refresh();toast('已提交；服务器继续运行，无需保持此网页打开。');
    });
  });
  document.addEventListener('change',event=>{
    if(!event.target.closest('#execution-workspace'))return;const name=event.target.name;
    if(['workspace-machine','machine','terminal-machine','file-machine'].includes(name))selectMachine(event.target.value);
    if(name==='workspace-project')selectProject(event.target.value);
    if(name==='release'){query('#release-full').textContent=event.target.value;query('#release-full').title=event.target.value;submitKey=crypto.randomUUID();updateControls();}
    if(name==='priority'){submitKey=crypto.randomUUID();updateControls();}
    if(name==='file-area'){query('[name=file-path]').value='.';query('[name=file-run-id]').value='';query('[name=file-run]').value='';query('#workspace-result').textContent='已切换文件区域。';updateControls();}
    if(name==='file-run')query('[name=file-run-id]').value=event.target.value;
  });
  document.addEventListener('input',event=>{if(!event.target.closest('#train-form'))return;submitKey=crypto.randomUUID();const selected=query('[name=machine]').value;if(selected!==machine)selectMachine(selected);});
  document.addEventListener('gpuq-terminal-state',event=>{terminalSessions=event.detail.sessions||[];if(section&&actor)renderProject();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPolling();else armPolling();});
  return ()=>{
    if(!store.production)return;
    if(!section){section=document.createElement('section');section.id='execution-workspace';section.className='execution-workspace';document.querySelector('#execution-host').append(section);log=document.createElement('dialog');log.className='job-log-dialog';log.setAttribute('aria-labelledby','job-log-title');log.innerHTML='<div class="modal-head"><h2 id="job-log-title">训练日志 · 最近 200 行</h2><button class="button" id="close-job-log">关闭</button></div><pre></pre>';document.body.append(log);diagnostics.install();}
    diagnostics.sync();section.hidden=!store.principal;if(section.hidden){diagnostics.reset();actor=null;machine='';project='';catalog=[];catalogError='';epoch++;stopPolling();section.innerHTML='';notifyContext();return;}
    if(actor!==store.principal.userId){
      diagnostics.reset();
      actor=store.principal.userId;machine='';project='';catalog=[];catalogError='';epoch++;stopPolling();machineIdentity='';submitKey=crypto.randomUUID();operationBusy=false;projectBusy=false;
      section.innerHTML=`<section class="workspace-context" aria-labelledby="workspace-context-title"><div class="workspace-context-heading"><div><div class="eyebrow">WORKSPACE</div><h2 id="workspace-context-title">选择服务器与项目</h2></div><button class="button" id="projects-refresh">刷新项目</button></div><div class="workspace-context-grid"><label>服务器<select name="workspace-machine" aria-describedby="workspace-mode-note"></select></label><label>项目<select name="workspace-project"><option value="">个人工作区</option></select></label></div><p id="workspace-mode-note" class="muted"></p><p id="project-status" class="workspace-status" role="status" aria-live="polite"></p><details id="project-create"><summary>新建项目</summary><form id="project-create-form"><label>项目名称<input name="new-project" pattern="[a-z][a-z0-9_-]{0,47}" maxlength="48" required placeholder="例如 vision-baseline" spellcheck="false" autocomplete="off"></label><label>Python 环境<select name="environment-mode" aria-describedby="environment-mode-note"><option value="shared">共享基础包（默认）</option><option value="isolated">完全隔离（不继承基础包）</option></select></label><button type="submit" class="button">创建项目</button></form><p id="environment-mode-note" class="muted">环境模式创建后固定。完全隔离模式使用基础 Python，但依赖需自行安装。</p><p class="muted">项目名使用小写字母、数字、短横线或下划线，以字母开头。离线依赖与模型可放入 /workspace/offline；训练不继承开发 HOME 中的缓存或令牌。</p></details><div id="project-detail" class="project-actions"><button class="button primary" id="project-publish">生成训练版本</button><button class="button danger" id="project-terminal-stop" hidden>结束项目开发终端</button><span class="muted">先完成上传并结束开发终端，再保存代码与环境版本。</span></div></section>
      <div class="terminal-controls"><select name="terminal-machine" hidden aria-label="终端服务器"></select><button id="terminal-open" class="button">新建独立终端</button><button id="terminal-reconnect" class="button">按会话 ID 重连</button><label class="host-terminal-choice"><input type="checkbox" name="terminal-host">宿主机 ROOT（不隔离）</label><span id="terminal-mode-note" class="muted"></span></div>
      <details class="execution-panel" id="workspace-files"><summary>代码与任务输出 · 上传 / 下载</summary><select name="file-machine" hidden aria-label="文件服务器"></select><div class="file-location-grid"><label>文件区域<select name="file-area"><option value="code">代码草稿</option><option value="output">任务输出（只读下载）</option></select></label><label>目录或文件的相对路径<input name="file-path" value="." spellcheck="false"></label></div><div class="output-run-fields"><label>本项目任务<select name="file-run"></select></label><label>完整任务 ID<input name="file-run-id" spellcheck="false" placeholder="选择上面的任务或输入完整 UUID"></label></div><div class="file-actions"><button class="button" id="workspace-list">列目录</button><button class="button" id="workspace-download">下载文件</button><input type="file" name="files" multiple aria-label="选择上传文件"><button class="button" id="workspace-upload">上传到代码草稿</button></div><pre id="workspace-result" class="file-result" aria-live="polite">仅操作当前服务器、当前工作区。大目录请使用 CLI。</pre></details>
      <details class="execution-panel"><summary>提交训练</summary><form id="train-form"><select name="machine" hidden aria-label="训练服务器"></select><div class="train-grid"><label>卡数<input name="cards" type="number" min="1" max="1" value="1" required></label><label>每卡最低显存 / GiB<input name="memory" type="number" min="0" max="128" value="0" step="0.5"></label><label>任务名称<input name="name" maxlength="64" value="train" required></label></div><div class="priority-choice"><label>任务优先级<select name="priority" aria-describedby="priority-note">${priorityOptions(store.principal?.role==='admin')}</select></label><p id="priority-note" class="priority-note"></p></div><label id="project-release-field">项目训练版本<select name="release"></select><code id="release-full" class="release-hash"></code><small>只使用已就绪的固定版本；刷新和发布不会替换已选版本。</small></label><label>训练命令<textarea name="command" rows="3" required spellcheck="false">python train.py</textarea></label><p class="muted">在所选服务器自动分配 GPU，不会换机。项目训练的 /workspace 只读，环境在 /opt/project-env，请把结果写入 /outputs；个人工作区的 Python 在 /opt/conda。</p><label>数据集版本（可选）<textarea name="datasets" rows="2" spellcheck="false" placeholder="从左侧「数据集」选择；多个版本用空格分隔"></textarea></label><p class="muted">只挂载你获授权且本机就绪的数据，路径 /data2/数据集名称。准备数据不占 GPU。</p><button type="submit" class="button primary">提交训练</button></form></details>
      <div class="section-kicker"><span>我的训练任务</span><span id="my-job-count"></span></div><p class="muted">排队、运行及待核对任务均占用个人额度；取消确认后释放。<a href="/guide/user" target="_blank" rel="noopener">用户手册</a></p><div id="my-job-table"></div>`;
      notifyContext();
    }
    const machines=store.data?.machines||[],next=JSON.stringify(machines);
    if(machineIdentity!==next){machineIdentity=next;const options='<option value="">请选择服务器</option>'+machines.map(item=>`<option value="${escape(item.id)}">${escape(item.id)}</option>`).join('');for(const name of ['workspace-machine','machine','terminal-machine','file-machine'])query(`[name=${name}]`).innerHTML=options;if(!machines.some(item=>item.id===machine)){machine='';project='';catalog=[];epoch++;clearFileContext();notifyContext();}syncMachineFields();}
    const jobs=ownJobs();renderTaskTable(query('#my-job-table'),jobs,{admin:store.principal?.role==='admin',userId:actor});query('#my-job-count').textContent=jobs.filter(job=>!terminal.has(job.state)).length+' 个待完成任务';renderProject();
  };
}

export function canEditPriority(job,admin=false){return admin&&job.canSetPriority===true&&['PENDING','QUEUED'].includes(job.state)&&!job.cancelRequested&&['idle','P1','normal','P3','high'].includes(job.priority);}
export function taskTable(jobs,{admin=false,userId}={}){return `<div class="live-table-wrap task-table-wrap"><table class="live-table task-table"><caption class="sr-only">训练任务、优先级与最近调度结果</caption><thead><tr><th>任务 / 用户</th><th>机器 / 卡数</th><th>状态</th><th>优先级 / 调度</th><th>操作</th></tr></thead><tbody>${[...jobs].reverse().map(job=>`<tr><td data-label="任务 / 用户"><strong>${escape(job.name)}</strong><small>${escape(job.username)} · ${escape(job.id)}</small>${job.project?`<small>${escape(job.project)} · ${escape(job.release||'')}</small>`:''}</td><td data-label="机器 / 卡数">${escape(job.machine)}<small>${escape(job.cards)} 张${job.assignedIndices?.length?' · GPU '+escape(job.assignedIndices.join(',')):''}</small></td><td data-label="状态"><span class="task-state">${escape(taskStateLabel(job))}</span><small>${escape(job.state)}${job.cancelRequested&&!terminal.has(job.state)?' · 正在取消':''}</small>${job.preempted?'<small>已写入的输出保留，不自动恢复。</small>':''}${job.error?`<small class="task-error">${escape(job.error)}</small>`:''}</td><td data-label="优先级 / 调度"><span class="priority-pill priority-${Object.hasOwn(priorities,job.priority)?job.priority:'unknown'}">${escape(priorityRankLabel(job))}</span>${Number.isInteger(job.schedulerPriority)?`<small>节点优先级：P${escape(job.schedulerPriority)}</small>`:''}<small>${escape(schedulingContractLabel(job.schedulerPolicy??{yield_policy:job.yieldPolicy,restart_policy:job.restartPolicy}))}</small><small>调度状态：${escape(job.schedulerState||'未提供')}</small><small class="queue-reason">${escape(job.queueReason||'暂无调度说明。')}</small><small class="scheduler-time">核对时间：${escape(sampleTime(job.schedulerCheckedAt))}</small>${canEditPriority(job,admin)?`<div class="priority-editor" data-priority-editor><label><span class="sr-only">${escape(job.name)} 的排队优先级</span><select data-job-priority="${escape(job.id)}" data-original-priority="${escape(job.priority)}">${priorityRankOptions(job.priority)}</select></label><button class="button" data-job-priority-save="${escape(job.id)}">保存优先级</button><small>仅改排队顺序，不改变让位和重启方式。</small></div>`:''}</td><td data-label="操作"><div class="task-actions"><button class="button" data-job-logs="${escape(job.id)}">日志</button>${job.project&&(!userId||job.userId===userId)?`<button class="button" data-job-output="${escape(job.id)}">输出</button>`:''}<button class="button danger" data-job-cancel="${escape(job.id)}" ${terminal.has(job.state)||job.cancelRequested?'disabled':''}>取消</button></div></td></tr>`).join('')||'<tr><td colspan="5" class="task-empty">暂无任务。先选择服务器，准备代码，再提交训练。</td></tr>'}</tbody></table></div>`;}
export function renderTaskTable(container,jobs,options={}){
  const drafts=new Map([...container.querySelectorAll('[data-job-priority]')].filter(input=>input.value!==input.dataset.originalPriority).map(input=>[input.dataset.jobPriority,{value:input.value,original:input.dataset.originalPriority}]));
  const active=container.ownerDocument.activeElement,focus=active?.dataset?.jobPriority?['jobPriority',active.dataset.jobPriority]:active?.dataset?.jobPrioritySave?['jobPrioritySave',active.dataset.jobPrioritySave]:null;
  const scroll=container.querySelector('.task-table-wrap'),top=scroll?.scrollTop||0,left=scroll?.scrollLeft||0;
  container.innerHTML=taskTable(jobs,options);
  for(const input of container.querySelectorAll('[data-job-priority]'))if(drafts.has(input.dataset.jobPriority)){const draft=drafts.get(input.dataset.jobPriority);input.value=draft.value;input.dataset.originalPriority=draft.original;}
  if(focus)for(const input of container.querySelectorAll('[data-job-priority],[data-job-priority-save]'))if(input.dataset[focus[0]]===focus[1])input.focus({preventScroll:true});
  const next=container.querySelector('.task-table-wrap');if(next){next.scrollTop=top;next.scrollLeft=left;}
}
