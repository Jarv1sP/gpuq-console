import {createJobDiagnostics} from './job-diagnostics-ui.js';
import {jobProgressHTML,jobNotificationHTML} from './job-progress-ui.js';
import {yieldCapable} from './scheduling-policy.js';
import {schedulingFields,schedulingFromForm,schedulingSummary} from './scheduling-ui.js';
import {elasticCapable,placementCapable} from './gpu-allocation.js';
import {elasticFields,elasticFromForm,allocationSummary,placementFields,placementFromForm,placementSummary} from './gpu-allocation-ui.js';
import {taskDescription} from './task-metadata.js';
import {workbenchCards,jobOverviewHTML,endedJob,stateHTML,stateClass,trainingReadout} from './workbench-ui.js';
import {revealSheet,dismissSheet,sharedObject} from './motion-ui.js';
import {taskNotesMarkup,createTaskNotesUI} from './task-notes-ui.js';
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
  return {PREPARING_DATA:'准备数据 · 不占 GPU',SUBMITTING:'提交中',PENDING:'排队中',QUEUED:'排队中',STARTING:'启动中',RUNNING:'运行中',UNKNOWN:'状态待核对',SUCCEEDED:'已完成',FAILED:'失败',CANCELED:'已取消',PREEMPTING:'正在让位',PREEMPTED:'让位结束'}[job.state]||job.state||'状态未知';
}
export const validProject=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(value);
export function projectStatusText(info,hasTerminal=false){
  const labels={DRAFT:'代码草稿',READY:'已有就绪版本',PUBLISHING:'正在生成训练版本',FAILED:'生成训练版本失败'};
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
  if(hasTerminal)parts.push('先结束项目开发终端，再生成训练版本。');
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
    if(final&&(receipt?.complete!==true||receipt.size!==file.size||receipt.sha256!==sha256))throw Error('服务器尚未确认完整文件及校验和；请重新上传此文件，确认成功后再生成训练版本。');
    offset+=bytes.length;progress(offset,file.size);
  }while(offset<file.size);
}

export function executionUI(store,refresh,toast){
  let section,log,actor=null,submitKey=crypto.randomUUID(),machine='',project='',catalog=[],catalogError='',projectBusy=false,operationBusy=false;
  let epoch=0,pollTimer=null,pollCount=0,terminalSessions=[],machineIdentity='';
  let submitDialog,settingsDialog,settingsSource=null,outputPlace=null,focusedJob=null,jobHTML='',lastJobs=new Map(),liveJobs=new Set(),deepLinkHandled=false,notes=null,notesJob=null,notesGeneration=0;
  const jobHeading=id=>[...document.querySelectorAll('[data-workbench-job]')].find(row=>row.dataset.workbenchJob===id)?.querySelector('.wb-job-heading');
  const diagnostics=createJobDiagnostics(store,()=>log,toast,{drawer:true,header:job=>`<span class="sheet-object">${stateHTML(job,false)}<span>${escape(job.name||'训练详情')}</span></span>`,reveal:(dialog,job,origin)=>{revealSheet(dialog,{drilldown:true});sharedObject(origin||jobHeading(job.id),dialog.querySelector('.sheet-object'));},dismiss:dialog=>dismissSheet(dialog,{drilldown:true,target:jobHeading(focusedJob)}),overview:job=>jobOverviewHTML(job,{owned:job.userId===store.principal?.userId,schedulingHTML:allocationSummary(job)+placementSummary(job)+`<span>排队优先级：${escape(priorityRankLabel(job))}</span>`+schedulingSummary(job)+`<span>${escape(schedulingContractLabel(job.schedulerPolicy??{yield_policy:job.yieldPolicy,restart_policy:job.restartPolicy}))}</span><span>调度状态：${escape(job.schedulerState||'未提供')}</span><span>核对时间：${escape(sampleTime(job.schedulerCheckedAt))}</span>`}),output:showOutput,notes:showNotes,onView:next=>{if(next!=='notes')notes?.sync(false,true);}});
  const call=(operation,args)=>store.call(operation,args),query=selector=>section?.querySelector(selector)||submitDialog?.querySelector(selector)||settingsDialog?.querySelector(selector)||log?.querySelector(selector)||document.querySelector('#shell-context')?.querySelector(selector);
  const context=()=>({machine,...(project?{project}:{})}),currentProject=()=>catalog.find(item=>item.project===project);
  const currentToken=()=>JSON.stringify([actor,machine,project,epoch]),ownJobs=()=>store.jobs.filter(job=>job.userId===store.principal?.userId);
  const priorityAvailable=()=>store.data?.execution?.priorityCapabilities?.[machine]===true;
  const customAvailable=()=>!store.data?.gpuq?.stale&&yieldCapable(store.data?.gpuq?.hosts?.find(h=>h.id===machine));
  const enabled=()=>store.production&&!!store.principal&&store.data?.executionEnabled===true&&(store.data?.machines||[]).some(item=>item.id===machine);
  const isVisible=()=>!document.hidden&&!section?.closest('[data-page]')?.hidden;
  const hasTerminal=()=>terminalSessions.some(item=>item.machine===machine&&item.project===project&&item.userId===actor);
  const status=(text,error=false)=>{const element=query('#project-status');if(element){element.textContent=text;element.classList.toggle('form-error',error);}};
  const stopPolling=()=>{clearTimeout(pollTimer);pollTimer=null;};
  function notifyContext(){document.dispatchEvent(new CustomEvent('gpuq-workspace-context',{detail:{userId:actor,...context()}}));}
  const reduced=()=>matchMedia('(prefers-reduced-motion:reduce)').matches;
  function showSheet(dialog,options={}){if(dialog.open)return;dialog.showModal();revealSheet(dialog,options);}
  function closeSettings(){if(!settingsSource)return;const source=settingsSource;settingsSource=null;source.append(...settingsDialog.querySelector('.sheet-scroll').children);source.open=false;settingsDialog.close();}
  function settings(source){closeSettings();settingsSource=source;settingsDialog.querySelector('h2').textContent=source.querySelector('summary').textContent;for(const control of source.querySelectorAll('input,select,textarea'))control.setAttribute('form','train-form');settingsDialog.querySelector('.sheet-scroll').append(...[...source.children].filter(child=>child.tagName!=='SUMMARY'));showSheet(settingsDialog,{drilldown:true});}
  function adaptWorkspace(){
    const selectors=section.querySelectorAll('.workspace-context-grid>label');
    for(const [index,selector] of ['#context-machine','#context-project'].entries()){const proxy=document.querySelector(selector),label=selectors[index],select=label?.querySelector('select');if(proxy&&label&&select){select.id=proxy.id;proxy.closest('label').replaceWith(label);}}
    section.querySelector('.workspace-context-grid').remove();
    section.querySelector('.workspace-context-heading').querySelector('.eyebrow').textContent='代码与环境';
    section.querySelector('#workspace-context-title').textContent='项目与训练版本';
    for(const id of ['project-publish','terminal-open'])query('#'+id).classList.remove('primary');
    const train=section.querySelector('#train-form'),panel=train.closest('details');panel.id='train-panel';panel.querySelector('summary').classList.add('sr-only');
    submitDialog=document.createElement('dialog');submitDialog.id='work-submit';submitDialog.className='work-sheet submit-sheet';submitDialog.setAttribute('aria-labelledby','submit-title');
    submitDialog.innerHTML='<header class="sheet-header glass"><div><p id="submit-context" class="mono"></p><h2 id="submit-title">提交训练</h2></div><button class="button quiet" type="button" id="close-submit" aria-label="关闭提交抽屉">关闭</button></header>';
    submitDialog.append(panel);document.body.append(submitDialog);
    const scroll=document.createElement('div');scroll.className='sheet-scroll';const submit=train.querySelector('[type=submit]');for(const child of [...train.children])if(child!==submit)scroll.append(child);train.append(scroll);
    const checks=document.createElement('section');checks.className='submit-checks';checks.innerHTML='<div class="spread"><h3>提交前检查</h3><button class="button quiet" type="button" id="submit-check-refresh">重新核对</button></div><ul id="submit-check-list" class="checks"></ul>';
    const cli=document.createElement('details');cli.className='submit-cli';cli.innerHTML='<summary>等价命令 · 你的电脑</summary><pre id="submit-command" tabindex="0"></pre><button class="button quiet" type="button" id="copy-submit-command">复制完整命令</button><p class="muted">命令包含当前固定版本与服务器；请先在自己的电脑登录 gpuctl。</p>';
    scroll.append(checks,cli);const footer=document.createElement('div');footer.className='sheet-footer glass';footer.innerHTML='<p id="submit-summary" class="muted">提交后可关闭网页，服务器继续运行。</p>';footer.append(submit);train.append(footer);
    panel.addEventListener('toggle',()=>{if(panel.open){updatePreflight();showSheet(submitDialog);}else submitDialog.close();});
    submitDialog.addEventListener('close',()=>{if(submitDialog.open)return;closeSettings();panel.open=false;});
    submitDialog.addEventListener('cancel',event=>{event.preventDefault();closeSettings();dismissSheet(submitDialog);});
    settingsDialog=document.createElement('dialog');settingsDialog.id='work-submit-panel';settingsDialog.className='work-sheet settings-sheet';settingsDialog.setAttribute('aria-labelledby','submit-panel-title');settingsDialog.innerHTML='<header class="sheet-header glass"><h2 id="submit-panel-title">提交设置</h2><button class="button quiet" id="close-submit-panel" type="button">返回提交</button></header><div class="sheet-scroll"></div>';document.body.append(settingsDialog);
    settingsDialog.addEventListener('cancel',event=>{event.preventDefault();dismissSheet(settingsDialog,{drilldown:true});closeSettings();});settingsDialog.addEventListener('close',()=>{if(!settingsDialog.open)closeSettings();});
    for(const detail of train.querySelectorAll('.training-advanced>details'))detail.querySelector('summary').addEventListener('click',event=>{event.preventDefault();settings(detail);});
    const layout=document.createElement('div');layout.className='wb-layout';const jobs=document.createElement('section');jobs.className='wb-jobs';jobs.setAttribute('aria-label','我的训练');const rail=document.createElement('aside');rail.className='wb-rail';rail.setAttribute('aria-label','项目、开发终端与文件');
    const table=query('#my-job-table'),kicker=section.querySelector('.section-kicker'),explanation=kicker.nextElementSibling;explanation.className='wb-job-explanation muted';jobs.append(table,kicker,explanation);rail.append(...section.children);layout.append(jobs,rail);section.append(layout);
  }
  function updatePreflight(){
    if(!submitDialog||!actor)return;query('#submit-context').textContent=(machine||'未选择服务器')+' · '+(project||'个人工作区');
    const user=store.users.find(item=>item.id===actor),used=store.usage(actor),quota=user?.total,info=currentProject(),host=store.data?.gpuq?.hosts?.find(item=>item.id===machine),fresh=store.production&&!store.data?.gpuq?.stale&&host?.reachable===true;
    const release=query('[name=release]').value,authorized=enabled()&&user?.limits?.[machine]>0;
    const rows=[['服务器授权',authorized?'已授权 '+machine:'选择获授权服务器',authorized],['额度',Number.isFinite(quota)?`已占 ${used} / ${quota} 张；准备数据期间不占额度，数据就绪后由后台再次核对。`:'额度尚未确认',Number.isFinite(quota)],['训练版本',project?(readyReleases(info).some(item=>item.release===release)?'已就绪的固定版本；提交时再次校验。':'先生成可用训练版本。'):'使用个人工作区；提交时再次核对。',!project||readyReleases(info).some(item=>item.release===release)],['服务器采集',fresh?'当前采集可用；启动由调度器确认。':'采集未知或过期；不会当作空闲。',fresh],['数据集',query('[name=datasets]').value.trim()?'提交后先校验固定版本与本机副本；需要时准备数据。':'本次不挂载数据集。',!query('[name=datasets]').value.trim()]];
    query('#submit-check-list').innerHTML=rows.map(([label,text,ok])=>`<li><span class="what">${escape(label)}<small>${escape(text)}</small></span><span class="${ok?'v-ok':'v-wait'}">${ok?'已确认':'待核对'}</span></li>`).join('');
    query('#submit-summary').textContent=query('[name=datasets]').value.trim()?'先准备数据，再核对额度并排队。提交后可关闭网页。':'提交后由服务器继续运行，可以关闭网页。';
    const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'",get=name=>query(`[name=${name}]`).value;
    const args=['gpuctl run',quote(machine||'SERVER'),'-g',get('cards'),'--min-vram',get('memory'),'--name',quote(get('name'))];
    if(project)args.push('--project',quote(project),'--release',quote(release));if(store.data?.taskMetadata?.version===1&&get('task-description').trim())args.push('--description',quote(get('task-description')));
    if(query('[name=custom-policy]').checked){args.push('--rank',get('queue-rank'),'--yield',get('yield-policy'),'--restart-policy',get('restart-policy'));if(query('[name=checkpointable]').checked)args.push('--checkpointable');if(get('request-mode'))args.push('--mode',get('request-mode'));}else if(priorityAvailable())args.push('--priority',get('priority'));
    if(query('[name=elastic]').checked){args.push('--min-cards',get('min-cards'),'--global-batch',get('global-batch'),'--micro-batch',get('micro-batch'));if(query('[name=auto-expand]').checked)args.push('--auto-expand');}
    if(get('gpu-placement')!=='any'){args.push('--gpu',quote(get('gpu-indices')));if(get('gpu-placement')==='shared')args.push('--share','--vram-mib',get('vram-mib'));if(query('[name=hami]').checked)args.push('--hami','--sm-percent',get('sm-percent'));}
    for(const ref of get('datasets').trim().split(/\s+/).filter(Boolean))args.push('--data',quote(ref));args.push('-- /bin/bash -c',quote(get('command')));query('#submit-command').textContent=args.join(' ');
  }
  function renderJobs(jobs){
    const table=query('#my-job-table'),detailKey=item=>item.className+'|'+(item.closest('[data-workbench-job]')?.dataset.workbenchJob||''),details=new Map([...table.querySelectorAll('details')].map(item=>[detailKey(item),item.open])),scrolls=new Map([...table.querySelectorAll('.wb-scroll-list')].map(item=>[item.getAttribute('aria-label'),item.scrollTop])),active=document.activeElement,focus=table.contains(active)?{id:active.closest('[data-workbench-job]')?.dataset.workbenchJob,hook:[...active.attributes].find(attr=>attr.name.startsWith('data-'))?.name}:null;
    const actions=job=>`${jobNotificationHTML(job,actor)}<button class="button quiet" data-job-logs="${escape(job.id)}">日志</button><button class="button quiet" data-job-detail="${escape(job.id)}" data-job-view="diagnostics">诊断</button>${job.project?`<button class="button quiet" data-job-output="${escape(job.id)}">输出</button>`:''}<button class="button quiet" data-job-detail="${escape(job.id)}" data-job-view="notes">留言</button><button class="button danger" data-job-cancel="${escape(job.id)}" ${endedJob(job)||job.cancelRequested?'disabled':''}>取消</button>${canEditPriority(job,store.principal?.role==='admin')?`<details class="wb-priority" data-priority-editor><summary>排队优先级</summary><select data-job-priority="${escape(job.id)}" data-original-priority="${escape(job.priority)}">${priorityRankOptions(job.priority)}</select><button class="button quiet" data-job-priority-save="${escape(job.id)}">保存优先级</button></details>`:''}`;
    const drafts=new Map([...table.querySelectorAll('[data-job-priority]')].map(input=>[input.dataset.jobPriority,{value:input.value,original:input.dataset.originalPriority}]));
    const html=workbenchCards(jobs,{actions,focusId:focusedJob});if(html===jobHTML)return;jobHTML=html;table.innerHTML=html;
    for(const detail of table.querySelectorAll('details'))if(details.has(detailKey(detail)))detail.open=details.get(detailKey(detail));
    for(const list of table.querySelectorAll('.wb-scroll-list'))if(scrolls.has(list.getAttribute('aria-label')))list.scrollTop=scrolls.get(list.getAttribute('aria-label'));
    for(const input of table.querySelectorAll('[data-job-priority]')){const draft=drafts.get(input.dataset.jobPriority);if(draft&&draft.value!==draft.original){input.value=draft.value;input.dataset.originalPriority=draft.original;}}
    for(const job of jobs){const previous=lastJobs.get(job.id),row=[...table.querySelectorAll('[data-workbench-job]')].find(item=>item.dataset.workbenchJob===job.id);if(previous&&row&&previous.state!==job.state){row.animate([{outline:'1px solid var(--line-3)'},{outline:'1px solid transparent'}],{duration:reduced()?150:220});if(['RUNNING','STARTING','SUBMITTING'].includes(job.state))liveJobs.add(job.id);}if(previous&&row&&previous.percent!==trainingReadout(job).percent&&trainingReadout(job).percent!==null){row.querySelector('.wb-progress-number')?.animate(reduced()?[{opacity:.4},{opacity:1}]:[{opacity:.4,transform:`translateY(${trainingReadout(job).percent>(previous.percent??0)?3:-3}px)`},{opacity:1,transform:'none'}],{duration:reduced()?150:220});if(job.state==='RUNNING')liveJobs.add(job.id);}if(liveJobs.has(job.id)&&['st-run','st-start'].includes(stateClass(job)))row?.querySelector('.st')?.classList.add('is-live');}
    lastJobs=new Map(jobs.map(job=>[job.id,{state:job.state,percent:trainingReadout(job).percent}]));
    if(focus?.id&&focus.hook)for(const button of table.querySelectorAll(`[${focus.hook}]`))if(button.closest('[data-workbench-job]')?.dataset.workbenchJob===focus.id){button.focus({preventScroll:true});break;}
  }
  async function showOutput(id,container){
    const job=ownJobs().find(item=>item.id===id);if(!job?.project){container.textContent='这项任务未使用项目输出目录；个人工作区文件可在工作台查看。';return;}
    const files=query('#workspace-files');if(!outputPlace){outputPlace=document.createComment('workspace files');files.before(outputPlace);}container.append(files);files.open=true;
    try{await selectMachine(job.machine);await selectProject(job.project);if(machine!==job.machine||project!==job.project)throw Error('无法确认任务对应的项目，请刷新项目列表。');query('[name=file-area]').value='output';query('[name=file-path]').value='.';query('[name=file-run-id]').value=job.id;renderRuns();query('[name=file-run]').value=job.id;updateControls();await listFiles();}catch(error){query('#workspace-result').textContent=error.message;}
  }
  async function showNotes(id,container){
    if(notesJob===id&&notes){notes.sync(true,true);return;}notes?.reset();notes=null;notesJob=id;const generation=++notesGeneration,owner=actor;container.textContent='正在核对任务留言功能…';
    try{const info=await call('community.info',{});if(generation!==notesGeneration||owner!==actor)return;if(info.enabled!==true||!info.capabilities?.includes('task-notes-v1')){container.textContent='当前后台尚未提供任务留言功能。';return;}
      container.className='job-notes';container.innerHTML=taskNotesMarkup.replace(/(id|for)="([a-z][a-z-]*)"/g,(_,attribute,value)=>`${attribute}="drawer-${value}"`);notes=createTaskNotesUI(container,store,toast,{prefix:'drawer-',jobId:id});container.querySelector('#drawer-task-note-lifetime').value='task';notes.sync(true,true);
    }catch(error){if(generation===notesGeneration&&owner===actor)container.textContent='留言暂不可用：'+error.message;}
  }
  document.addEventListener('gpuq-job-drawer-close',()=>{notesGeneration++;notes?.reset();notes=null;notesJob=null;const files=query('#workspace-files');if(outputPlace&&files){outputPlace.after(files);outputPlace.remove();outputPlace=null;}});
  function assertContext(){if(!enabled())throw Error('先在工作台顶部选择一台已授权服务器。');if(project&&!currentProject())throw Error('项目状态尚未读取，请刷新后再试。');return context();}
  function updateControls(){
    if(!section||!actor)return;
    const available=enabled(),locked=operationBusy||projectBusy,info=currentProject(),publishing=info?.state==='PUBLISHING';
    for(const name of ['workspace-machine','workspace-project'])query(`[name=${name}]`).disabled=locked||(name==='workspace-project'&&!available);
    query('#projects-refresh').disabled=!available||locked;query('#project-create-form [type=submit]').disabled=!available||locked;
    query('#project-publish').disabled=!available||!project||!info||locked||publishing||hasTerminal()||!!catalogError;
    query('#project-terminal-stop').hidden=!hasTerminal();query('#project-terminal-stop').disabled=locked;
    const admin=store.principal?.role==='admin',host=query('#host-maintenance');host.hidden=!admin;if(!admin)host.open=false;
    for(const id of ['terminal-root-open','terminal-root-reconnect'])query('#'+id).disabled=!admin||!available||locked;
    query('#host-terminal-target').textContent=machine||'先选择服务器';
    for(const id of ['terminal-open','terminal-reconnect'])query('#'+id).disabled=!available||locked||publishing;
    const release=query('[name=release]');release.disabled=!project||locked||!readyReleases(info).length;
    const custom=query('[name=custom-policy]'),customOn=custom.checked;
    custom.disabled=!available||locked;
    for(const name of ['queue-rank','yield-policy','restart-policy','checkpointable','request-mode'])query(`[name=${name}]`).disabled=!available||locked||!customOn;
    query('#custom-policy-note').textContent=customAvailable()?'等级与让位独立。只抢占严格低等级且明确允许让位的任务；保存失败或超时不会强制杀掉保存任务。':'节点尚未确认训练控制通道，不能提交自定义策略；不会自动降级。';
    const elastic=query('[name=elastic]'),elasticOn=elastic.checked;
    elastic.disabled=!available||locked;
    for(const name of ['min-cards','global-batch','micro-batch','auto-expand'])query(`[name=${name}]`).disabled=!available||locked||!elasticOn;
    const elasticReady=!store.data?.gpuq?.stale&&elasticCapable(store.data?.gpuq?.hosts?.find(h=>h.id===machine));
    query('#elastic-note').textContent=elasticReady?'只选择可整除 global batch 的卡数；配额预留最大卡数。自动扩卡须接入 checkpoint、弹性 batch，启用保存让位和自动恢复。':'节点尚未确认弹性分配通道，弹性任务暂不能提交。';
    const placementMode=query('[name=gpu-placement]'),shared=placementMode.value==='shared',hami=query('[name=hami]');
    placementMode.disabled=!available||locked;
    query('[name=gpu-indices]').disabled=!available||locked||placementMode.value==='any';
    for(const name of ['vram-mib','hami'])query(`[name=${name}]`).disabled=!available||locked||!shared;
    query('[name=sm-percent]').disabled=!available||locked||!shared||!hami.checked;
    const chosenHost=store.data?.gpuq?.hosts?.find(h=>h.id===machine);
    const placementReady=placementMode.value==='any'||!store.data?.gpuq?.stale&&placementCapable(chosenHost,{shared,hami:shared&&hami.checked,smPercent:shared&&hami.checked?Number(query('[name=sm-percent]').value):100});
    query('#placement-note').textContent=placementReady?'先在资源页观察逐卡显存和进程，再选择同卡共享。共享只需提交者同意；预算用于准入，普通共享没有硬显存限制。HAMi 只限制本任务，不限制同卡外部进程。':'节点未确认所选固定/共享或 HAMi 功能，暂不能提交。';
    const priority=query('[name=priority]');priority.disabled=!available||locked||customOn;
    for(const option of priority.options){option.disabled=option.value!=='normal'&&!priorityAvailable();if(option.value==='normal')option.textContent=machine&&!priorityAvailable()?'默认（旧策略未确认）':'普通';}
    query('#priority-note').textContent=(!machine?'选择服务器后确认优先级能力。':!priorityAvailable()?'这台服务器尚未确认支持优先级控制。':'')+' '+(machine&&!priorityAvailable()&&priority.value==='normal'?'暂按服务器原有策略提交。':priorityDescription(priority.value));
    query('#priority-note').classList.toggle('priority-warning',priority.value==='idle'||priority.value!=='normal'&&!priorityAvailable());
    query('[name=task-description]').disabled=locked||store.data?.taskMetadata?.version!==1;
    query('#train-form [type=submit]').disabled=!available||locked||!placementReady||(elasticOn&&!elasticReady)||(customOn?!customAvailable():priority.value!=='normal'&&!priorityAvailable())||(!!project&&(!!catalogError||!readyReleases(info).some(item=>item.release===release.value)));
    const output=project&&query('[name=file-area]').value==='output';
    for(const id of ['workspace-list','workspace-download'])query('#'+id).disabled=!available||locked;
    query('#workspace-upload').disabled=!available||locked||output||publishing;query('[name=files]').disabled=!available||locked||output||publishing;
    query('[name=file-area]').disabled=!project||locked;query('.output-run-fields').hidden=!output;query('#project-release-field').hidden=!project;query('#project-detail').hidden=!project;
    query('#workspace-mode-note').textContent=project?'代码草稿在 /workspace；项目环境在 /opt/project-env。发布后，训练读取固定只读版本，每项任务写入自己的 /outputs。':'个人工作区路径为 /workspace。终端、文件和训练共用此目录；新实验可单独创建项目。';
    query('#terminal-mode-note').textContent=project?'编辑代码、安装项目 Python 包；不分配 GPU。系统目录只读，不提供宿主 sudo。':'管理个人文件和 Python 包；不分配 GPU。系统目录只读，不提供宿主 sudo。';
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
    renderRuns();updateControls();updatePreflight();armPolling();document.dispatchEvent(new Event('gpuq-workspace-rendered'));
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
    if(button.id==='open-submit'){if(submitDialog)query('#train-panel').open=true;return;}
    if(button.hasAttribute('data-user-guide')){window.open('/guide/user','_blank','noopener');return;}
    if(button.id==='close-submit'){dismissSheet(submitDialog);return;}
    if(button.id==='close-submit-panel'){dismissSheet(settingsDialog,{drilldown:true});closeSettings();updatePreflight();return;}
    if(button.id==='submit-check-refresh'){document.querySelector('#refresh-state').click();if(project)loadProjectStatus();updatePreflight();return;}
    if(button.id==='copy-submit-command'){navigator.clipboard.writeText(query('#submit-command').textContent).then(()=>toast('完整命令已复制。'),()=>toast('复制失败；请选中命令手动复制。'));return;}
    if(button.dataset.jobDetail){focusedJob=button.dataset.jobDetail;document.dispatchEvent(new CustomEvent('gpuq-focused-job',{detail:{id:focusedJob}}));guarded(button,()=>diagnostics.openLogs(focusedJob,button.dataset.jobView||'overview',jobHeading(focusedJob)));return;}
    if(button.dataset.useMachine&&section&&actor)queueMicrotask(()=>selectMachine(button.dataset.useMachine).catch(error=>toast(error.message)));
    if(button.dataset.jobLogs){focusedJob=button.dataset.jobLogs;guarded(button,()=>diagnostics.openLogs(focusedJob,'logs',jobHeading(focusedJob)));}
    if(button.dataset.jobNotify)guarded(button,async()=>{
      const job=store.jobs.find(item=>item.id===button.dataset.jobNotify);
      if(!job||job.userId!==store.principal?.userId)throw Error('只能订阅自己的任务。');
      const enabled=job.notifications?.enabled!==true;
      await call('notifications.job',{jobId:job.id,enabled});refresh();toast(enabled?'Telegram 任务通知已开启。':'Telegram 任务通知已关闭。');
    });
    if(button.dataset.jobCancel&&window.confirm('取消这个训练任务？已保存的文件保留，确认停止后才释放额度。'))guarded(button,async()=>{await call('jobs.cancel',{jobId:button.dataset.jobCancel});refresh();toast('已请求取消；等待 GPUQ 确认释放。');});
    if(button.dataset.jobPrioritySave)guarded(button,async()=>{
      if(store.principal?.role!=='admin')throw Error('只有管理员可以调整排队任务优先级。');
      const jobId=button.dataset.jobPrioritySave,job=store.jobs.find(item=>item.id===jobId),control=button.closest('[data-priority-editor]')?.querySelector('select');
      if(!job||!canEditPriority(job,true)||!control)throw Error('任务已不在可调整的队列状态，请刷新后核对。');
      const priority=priorityRankValue(control.value);if(priority===job.priority){toast('优先级未改变。');return;}
      await call('jobs.priority',{jobId,priority,expectedPriority:control.dataset.originalPriority});control.dataset.originalPriority=priority;refresh();toast('已请求调整优先级；以下次调度核对结果为准。');
    });
    if(button.id==='close-job-log')dismissSheet(log,{drilldown:true,target:jobHeading(focusedJob)});
    if(button.id==='projects-refresh'){pollCount=0;loadProjects();}
    if(button.id==='project-publish')guarded(button,async()=>{const target=assertContext();if(!project)throw Error('先选择项目。');if(hasTerminal())throw Error('请先结束项目开发终端；断开连接不等于结束。');const result=await call('projects.publish',target);if(result.project!==project)throw Error('项目返回身份不匹配。');catalog=catalog.map(item=>item.project===project?result:item);catalogError='';pollCount=0;renderProject();toast(result.state==='READY'?'训练版本已就绪。训练使用选定的固定版本。':'正在生成训练版本；可稍后刷新，不会自动切换已选版本。');});
    if(button.id==='workspace-list')guarded(button,listFiles);
    if(button.id==='workspace-upload')guarded(button,async()=>{
      const target=fileContext(),dir=query('[name=file-path]').value||'.',files=[...query('[name=files]').files];if(target.area==='output')throw Error('任务输出只支持查看和下载。');if(!files.length)throw Error('先选择文件。');
      for(const file of files){const path=dir==='.'?file.name:dir+'/'+file.name,progress=offset=>{query('#workspace-result').textContent=`正在上传 ${file.name}：${offset} / ${file.size} B`;};
        if(target.project)await uploadProjectFile(file,{...target,path},args=>call('files.put',args),progress);
        else{let offset=0;do{const bytes=new Uint8Array(await file.slice(offset,offset+1048576).arrayBuffer());await call('files.put',{...target,path,offset,truncate:offset===0,data:base64(bytes)});offset+=bytes.length;progress(offset);}while(offset<file.size);}}
      query('#workspace-result').textContent=`已上传 ${files.length} 个文件${project?'到项目代码草稿；生成训练版本后才能用于训练。':'。'}`;renderProject();toast('文件上传完成。');
    });
    if(button.id==='workspace-download')guarded(button,async()=>{
      const target=fileContext(),path=query('[name=file-path]').value;if(!path||path==='.')throw Error('请填入要下载的文件相对路径。');let offset=0;const chunks=[];
      while(true){const result=await call('files.get',{...target,path,offset}),bytes=Uint8Array.from(atob(result.data),char=>char.charCodeAt(0));chunks.push(bytes);offset+=bytes.length;if(offset>100*1024*1024)throw Error('超过 100 MiB，请用 CLI 下载大文件。');if(result.eof)break;if(!bytes.length)throw Error('下载没有继续返回数据，请重试。');}
      const url=URL.createObjectURL(new Blob(chunks)),anchor=document.createElement('a');anchor.href=url;anchor.download=path.split('/').pop();anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    if(button.dataset.jobOutput)guarded(button,()=>diagnostics.openLogs(button.dataset.jobOutput,'output'));
  });
  document.addEventListener('submit',event=>{
    if(event.target.id==='project-create-form'){event.preventDefault();const slug=query('[name=new-project]').value.trim();guarded(event.target.querySelector('[type=submit]'),async()=>{
      assertContext();if(!validProject(slug))throw Error('项目名需小写字母开头，使用字母、数字、下划线或短横线，最多 48 位。');
      const environmentMode=query('[name=environment-mode]').value;if(!['shared','isolated'].includes(environmentMode))throw Error('请选择项目环境模式。');
      const result=await call('projects.create',{machine,project:slug,environmentMode});if(result.project!==slug)throw Error('项目返回身份不匹配。');if(environmentMode==='isolated'&&result.environmentMode!=='isolated')throw Error('节点未确认完全隔离模式；请升级节点后核对项目，不要开始安装环境。');catalog=[...catalog.filter(item=>item.project!==slug),result];project=slug;epoch++;query('[name=release]').value='';clearFileContext();catalogError='';renderProject();notifyContext();query('[name=new-project]').value='';query('#project-create').open=false;submitKey=crypto.randomUUID();toast('项目已创建。上传代码、安装项目环境，然后生成训练版本。');
    });return;}
    if(event.target.id!=='train-form')return;event.preventDefault();const form=new FormData(event.target);
    guarded(event.target.querySelector('[type=submit]'),async()=>{const target=assertContext();if(form.get('machine')!==machine)throw Error('服务器选择已改变，请核对工作台顶部后再提交。');const datasets=datasetReferences(form.get('datasets'));
      const customOn=query('[name=custom-policy]').checked;
      if(customOn&&!customAvailable())throw Error('节点未接通训练控制通道，不能降级提交。');
      const scheduling=customOn?schedulingFromForm(form,store.principal?.role==='admin'):null;
      if(scheduling?.mode&&scheduling.mode!=='queue'&&!store.data?.gpuq?.hosts?.find(h=>h.id===machine)?.gpuq?.capabilities?.includes('preempt-opt-in-only-v1'))throw Error('节点未接通抢占模式，请先升级。');
      const elastic=elasticFromForm(form,Number(form.get('cards')),scheduling);
      if(customOn&&!scheduling)throw Error('请重新核对自定义调度选项。');
      const priority=customOn?'normal':trainingPriority(form.get('priority'),store.principal?.role==='admin');if(!customOn&&priority!=='normal'&&!priorityAvailable())throw Error('尚未确认这台服务器支持优先级控制，请刷新核对或明确选择普通优先级。');
      const placement=placementFromForm(form,Number(form.get('cards')),elastic,scheduling,priority);
      await call('jobs.submit',{machine:target.machine,cards:Number(form.get('cards')),minVramGiB:Number(form.get('memory')),name:form.get('name')||'train',...(store.data?.taskMetadata?.version===1?{description:taskDescription(form.get('task-description')||'')}:{}),...(scheduling?{scheduling}:priorityAvailable()?{priority}:{}),...(elastic?{elastic}:{}),...(placement?{placement}:{}),argv:['/bin/bash','-c',String(form.get('command'))],key:submitKey,...trainingProject(project?currentProject():null,form.get('release')),...(datasets.length?{datasets,prepareData:true}:{})});submitKey=crypto.randomUUID();refresh();toast('已提交；服务器继续运行，无需保持此网页打开。');
    });
  });
  document.addEventListener('change',event=>{
    if(!event.target.closest('#execution-workspace,#work-submit,#work-submit-panel,#shell-context,.job-log-dialog'))return;const name=event.target.name;
    if(['workspace-machine','machine','terminal-machine','file-machine'].includes(name)){
      if(event.target.value!==machine&&terminalSessions.some(item=>item.userId===actor&&!item.detached)&&!window.confirm('切换服务器不会搬运代码、环境、数据或结果。当前终端会断开连接，会话保留，可从总控重连。继续切换？')){event.target.value=machine;return;}
      selectMachine(event.target.value);
    }
    if(name==='workspace-project')selectProject(event.target.value);
    if(name==='release'){query('#release-full').textContent=event.target.value;query('#release-full').title=event.target.value;submitKey=crypto.randomUUID();updateControls();}
    if(name==='priority'){submitKey=crypto.randomUUID();updateControls();}
    if(['custom-policy','queue-rank','yield-policy','restart-policy','checkpointable','request-mode','elastic','auto-expand'].includes(name)){submitKey=crypto.randomUUID();updateControls();}
    if(name==='file-area'){query('[name=file-path]').value='.';query('[name=file-run-id]').value='';query('[name=file-run]').value='';query('#workspace-result').textContent='已切换文件区域。';updateControls();}
    if(name==='file-run')query('[name=file-run-id]').value=event.target.value;
    updatePreflight();
  });
  document.addEventListener('input',event=>{if(!event.target.closest('#train-form,#work-submit-panel'))return;submitKey=crypto.randomUUID();const selected=query('[name=machine]').value;if(selected!==machine)selectMachine(selected);if(event.target.name==='sm-percent')updateControls();updatePreflight();});
  document.addEventListener('gpuq-open-submit',async event=>{
    if(!submitDialog||!actor)return;const detail=event.detail||{};if(detail.machine&&detail.machine!==machine)await selectMachine(detail.machine);if(detail.datasetRef){query('[name=datasets]').value=detail.datasetRef;submitKey=crypto.randomUUID();}
    query('#train-panel').open=true;updatePreflight();if(detail.origin)requestAnimationFrame(()=>sharedObject(detail.origin,query('[name=datasets]')));if(machine)loadProjectStatus();
  });
  document.addEventListener('gpuq-open-job',event=>{if(!log||!store.principal)return;const {id,view,origin}=event.detail||{};if(!store.jobs.some(job=>job.id===id)){toast('任务暂未出现在当前账号的状态中，请刷新核对。');return;}focusedJob=id;diagnostics.openLogs(id,view||'overview',origin).catch(error=>toast(error.message));});
  document.addEventListener('gpuq-terminal-state',event=>{terminalSessions=event.detail.sessions||[];if(section&&actor)renderProject();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPolling();else armPolling();});
  return ()=>{
    if(!section){section=document.createElement('section');section.id='execution-workspace';section.className='execution-workspace';document.querySelector('#execution-host').append(section);log=document.createElement('dialog');log.className='job-log-dialog';log.setAttribute('aria-labelledby','job-log-title');log.innerHTML='<div class="modal-head"><h2 id="job-log-title">训练日志 · 最近 200 行</h2><button class="button" id="close-job-log">关闭</button></div><pre></pre>';document.body.append(log);diagnostics.install();}
    diagnostics.sync();section.hidden=!store.principal;if(section.hidden){diagnostics.reset();submitDialog?.close();settingsDialog?.close();actor=null;machine='';project='';catalog=[];catalogError='';epoch++;stopPolling();section.innerHTML='';notifyContext();return;}
    if(actor!==store.principal.userId){
      diagnostics.reset();
      submitDialog?.close();submitDialog?.remove();settingsDialog?.close();settingsDialog?.remove();submitDialog=null;settingsDialog=null;settingsSource=null;jobHTML='';lastJobs.clear();liveJobs.clear();focusedJob=null;deepLinkHandled=false;
      actor=store.principal.userId;machine='';project='';catalog=[];catalogError='';epoch++;stopPolling();machineIdentity='';submitKey=crypto.randomUUID();operationBusy=false;projectBusy=false;
      section.innerHTML=`<section class="workspace-context" aria-labelledby="workspace-context-title"><div class="workspace-context-heading"><div><div class="eyebrow">WORKSPACE</div><h2 id="workspace-context-title">选择服务器与项目</h2></div><button class="button" id="projects-refresh">刷新项目</button></div><div class="workspace-context-grid"><label>服务器<select name="workspace-machine" aria-describedby="workspace-mode-note"></select></label><label>项目<select name="workspace-project"><option value="">个人工作区</option></select></label></div><p id="workspace-mode-note" class="muted"></p><p id="project-status" class="workspace-status" role="status" aria-live="polite"></p><details id="project-create"><summary>新建项目</summary><form id="project-create-form"><label>项目名称<input name="new-project" pattern="[a-z][a-z0-9_-]{0,47}" maxlength="48" required placeholder="例如 vision-baseline" spellcheck="false" autocomplete="off"></label><label>Python 环境<select name="environment-mode" aria-describedby="environment-mode-note"><option value="shared">共享基础包（默认）</option><option value="isolated">完全隔离（不继承基础包）</option></select></label><button type="submit" class="button">创建项目</button></form><p id="environment-mode-note" class="muted">环境模式创建后固定。完全隔离模式使用基础 Python，但依赖需自行安装。</p><p class="muted">项目名使用小写字母、数字、短横线或下划线，以字母开头。离线依赖与模型可放入 /workspace/offline；训练不继承开发 HOME 中的缓存或令牌。</p></details><div id="project-detail" class="project-actions"><button class="button primary" id="project-publish">生成训练版本</button><button class="button danger" id="project-terminal-stop" hidden>结束项目开发终端</button><span class="muted">先完成上传并结束开发终端，再保存代码与环境版本。</span></div></section>
      <section class="personal-terminal" aria-labelledby="personal-terminal-title"><div class="terminal-heading"><h3 id="personal-terminal-title">个人开发终端</h3><span class="terminal-scope">日常开发 · 不占 GPU</span></div><p id="terminal-mode-note" class="muted"></p><div class="terminal-controls"><select name="terminal-machine" hidden aria-label="终端服务器"></select><button id="terminal-open" class="button primary">新建开发终端</button><button id="terminal-reconnect" class="button">重连开发会话</button></div></section>
      <details id="host-maintenance" class="host-maintenance" hidden><summary>主机运维 · 管理员 ROOT</summary><p>目标：<strong id="host-terminal-target"></strong>。不进入当前项目，可修改整机并绕过 GPU 配额；仅用于系统维护。</p><div class="terminal-controls"><button id="terminal-root-open" class="button danger">新建 ROOT 运维终端</button><button id="terminal-root-reconnect" class="button">重连 ROOT 会话</button></div></details>
      <details class="execution-panel" id="workspace-files"><summary>代码与任务输出 · 上传 / 下载</summary><select name="file-machine" hidden aria-label="文件服务器"></select><div class="file-location-grid"><label>文件区域<select name="file-area"><option value="code">代码草稿</option><option value="output">任务输出（只读下载）</option></select></label><label>目录或文件的相对路径<input name="file-path" value="." spellcheck="false"></label></div><div class="output-run-fields"><label>本项目任务<select name="file-run"></select></label><label>完整任务 ID<input name="file-run-id" spellcheck="false" placeholder="选择上面的任务或输入完整 UUID"></label></div><div class="file-actions"><button class="button" id="workspace-list">列目录</button><button class="button" id="workspace-download">下载文件</button><input type="file" name="files" multiple aria-label="选择上传文件"><button class="button" id="workspace-upload">上传到代码草稿</button></div><pre id="workspace-result" class="file-result" aria-live="polite">仅操作当前服务器、当前工作区。大目录请使用 CLI。</pre></details>
      <details class="execution-panel"><summary>提交训练</summary><form id="train-form">
        <select name="machine" hidden aria-label="训练服务器"></select>
        <div class="train-grid"><label>卡数<input name="cards" type="number" min="1" max="1" value="1" required></label><label>每卡最低显存 / GiB<input name="memory" type="number" min="0" max="128" value="0" step="0.5"></label><label>任务名称<input name="name" maxlength="64" value="train" required></label></div>
        <label>任务描述（同机器授权成员可见）<textarea name="task-description" rows="3" maxlength="2000" placeholder="例如：验证新数据集上的 baseline，预计运行约两小时。不要填写密码或令牌。"></textarea></label>
        <div class="priority-choice"><label>任务优先级<select name="priority" aria-describedby="priority-note">${priorityOptions(store.principal?.role==='admin')}</select></label><p id="priority-note" class="priority-note"></p></div>
        <label id="project-release-field">项目训练版本<select name="release"></select><code id="release-full" class="release-hash"></code><small>只使用已就绪的固定版本；刷新和发布不会替换已选版本。</small></label>
        <label>训练命令<textarea name="command" rows="3" required spellcheck="false">python train.py</textarea></label>
        <p class="muted">在所选服务器自动分配 GPU，不会换机。项目训练的 /workspace 只读，环境在 /opt/project-env，请把结果写入 /outputs；个人工作区的 Python 在 /opt/conda。</p>
        <label>数据集版本（可选）<textarea name="datasets" rows="2" spellcheck="false" placeholder="从左侧「数据集」选择；多个版本用空格分隔"></textarea></label>
        <p class="muted">只挂载你获授权且本机就绪的数据，路径 /data2/数据集名称。准备数据不占 GPU。</p><div class="training-advanced">${schedulingFields(store.principal?.role==='admin')}${elasticFields()}${placementFields()}</div><button type="submit" class="button primary">提交训练</button>
      </form></details>
      <div class="section-kicker"><span>我的训练任务</span><span id="my-job-count"></span></div><p class="muted">排队、运行及待核对任务均占用个人额度；取消确认后释放。<button type="button" class="button quiet" data-user-guide>用户手册</button></p><div id="my-job-table"></div>`;
      adaptWorkspace();notifyContext();
    }
    const machines=store.data?.machines||[],next=JSON.stringify(machines);
    if(machineIdentity!==next){machineIdentity=next;const options='<option value="">请选择服务器</option>'+machines.map(item=>`<option value="${escape(item.id)}">${escape(item.id)}</option>`).join('');for(const name of ['workspace-machine','machine','terminal-machine','file-machine'])query(`[name=${name}]`).innerHTML=options;if(!machines.some(item=>item.id===machine)){machine='';project='';catalog=[];epoch++;clearFileContext();notifyContext();}syncMachineFields();}
    const jobs=ownJobs();renderJobs(jobs);query('#my-job-count').textContent=jobs.filter(job=>!terminal.has(job.state)).length+' 项进行中';renderProject();
    if(!deepLinkHandled){deepLinkHandled=true;const id=new URL(location.href).searchParams.get('job');if(id&&store.jobs.some(job=>job.id===id))diagnostics.openLogs(id,'overview');}
  };
}

export function canEditPriority(job,admin=false){return admin&&job.canSetPriority===true&&['PENDING','QUEUED'].includes(job.state)&&!job.cancelRequested&&['idle','P1','normal','P3','high'].includes(job.priority);}
export function taskIdentityHTML(job){
  const name=job.submitter?.name||job.submitterName||job.username||'未知提交者',username=job.submitter?.username||job.username;
  return `<strong>${escape(job.name)}</strong><small>${escape(name)}${username&&username!==name?'（'+escape(username)+'）':''} · ${escape(job.id)}</small>
    <p class="task-description">${escape(job.description||'未填写描述')}</p>${job.source==='native'?'<small>未关联平台提交记录</small>':''}`;
}
export function taskTable(jobs,{admin=false,userId}={}){return `<div class="live-table-wrap task-table-wrap"><table class="live-table task-table"><caption class="sr-only">训练任务、优先级与最近调度结果</caption><thead><tr><th>任务 / 用户</th><th>机器 / 卡数</th><th>状态</th><th>优先级 / 调度</th><th>操作</th></tr></thead><tbody>${[...jobs].reverse().map(job=>`<tr><td data-label="任务 / 用户">${taskIdentityHTML(job)}${job.project?`<small>${escape(job.project)} · ${escape(job.release||'')}</small>`:''}</td><td data-label="机器 / 卡数">${escape(job.machine)}${allocationSummary(job)}${placementSummary(job)}</td><td data-label="状态"><span class="task-state">${escape(taskStateLabel(job))}</span><small>${escape(job.state)}${job.cancelRequested&&!terminal.has(job.state)?' · 正在取消':''}</small>${job.preempted?'<small>已写入的输出保留，不自动恢复。</small>':''}${job.error?`<small class="task-error">${escape(job.error)}</small>`:''}${jobProgressHTML(job)}</td><td data-label="优先级 / 调度"><span class="priority-pill priority-${Object.hasOwn(priorities,job.priority)?job.priority:'unknown'}">${escape(priorityRankLabel(job))}</span>${schedulingSummary(job)}${Number.isInteger(job.schedulerPriority)?`<small>节点优先级：P${escape(job.schedulerPriority)}</small>`:''}<small>${escape(schedulingContractLabel(job.schedulerPolicy??{yield_policy:job.yieldPolicy,restart_policy:job.restartPolicy}))}</small><small>调度状态：${escape(job.schedulerState||'未提供')}</small><small class="queue-reason">${escape(job.queueReason||'暂无调度说明。')}</small><small class="scheduler-time">核对时间：${escape(sampleTime(job.schedulerCheckedAt))}</small>${canEditPriority(job,admin)?`<div class="priority-editor" data-priority-editor><label><span class="sr-only">${escape(job.name)} 的排队优先级</span><select data-job-priority="${escape(job.id)}" data-original-priority="${escape(job.priority)}">${priorityRankOptions(job.priority)}</select></label><button class="button" data-job-priority-save="${escape(job.id)}">保存优先级</button><small>仅改排队顺序，不改变让位和重启方式。</small></div>`:''}</td><td data-label="操作"><div class="task-actions">${jobNotificationHTML(job,userId)}<button class="button" data-job-logs="${escape(job.id)}">日志</button>${job.project&&(!userId||job.userId===userId)?`<button class="button" data-job-output="${escape(job.id)}">输出</button>`:''}<button class="button danger" data-job-cancel="${escape(job.id)}" ${terminal.has(job.state)||job.cancelRequested?'disabled':''}>取消</button></div></td></tr>`).join('')||'<tr><td colspan="5" class="task-empty">暂无任务。先选择服务器，准备代码，再提交训练。</td></tr>'}</tbody></table></div>`;}
export function renderTaskTable(container,jobs,options={}){
  const drafts=new Map([...container.querySelectorAll('[data-job-priority]')].filter(input=>input.value!==input.dataset.originalPriority).map(input=>[input.dataset.jobPriority,{value:input.value,original:input.dataset.originalPriority}]));
  const active=container.ownerDocument.activeElement,focus=active?.dataset?.jobPriority?['jobPriority',active.dataset.jobPriority]:active?.dataset?.jobPrioritySave?['jobPrioritySave',active.dataset.jobPrioritySave]:null;
  const scroll=container.querySelector('.task-table-wrap'),top=scroll?.scrollTop||0,left=scroll?.scrollLeft||0;
  container.innerHTML=taskTable(jobs,options);
  for(const input of container.querySelectorAll('[data-job-priority]'))if(drafts.has(input.dataset.jobPriority)){const draft=drafts.get(input.dataset.jobPriority);input.value=draft.value;input.dataset.originalPriority=draft.original;}
  if(focus)for(const input of container.querySelectorAll('[data-job-priority],[data-job-priority-save]'))if(input.dataset[focus[0]]===focus[1])input.focus({preventScroll:true});
  const next=container.querySelector('.task-table-wrap');if(next){next.scrollTop=top;next.scrollLeft=left;}
}
