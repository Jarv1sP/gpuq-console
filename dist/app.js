import {MACHINES} from './model.js';
import {DemoClient} from './client.js';
import {executionUI,renderTaskTable} from './execution-ui.js';
import {terminalUI} from './terminal-ui.js';
import {resourcesUI,monitorSummary} from './resources-ui.js';
import {datasetsUI} from './datasets-ui.js';
import {createCommunityUI} from './community-ui.js';
import {maintenanceUI,operationalMaintenanceUI} from './maintenance-ui.js';
import {maintenanceExperienceUI} from './maintenance-experience.js';
import {maintenanceActive} from './maintenance-state.js';
import {transfersUI} from './transfers-ui.js';
import {shellUI} from './shell-ui.js';
import {fadeDialog,reducedMotion} from './motion-ui.js';
import {copyHelp} from './copy-help-ui.js';
import {installAuthentication} from './auth-ui.js';
const store=await DemoClient.create(),$=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const capacity=MACHINES.reduce((n,m)=>n+m.cards,0);
let page='work',selected=null,draft=null,filter='pending',toastTimer,confirmAction,inviteCode=null,refreshing=false;
const shell=shellUI(store,{navigate:choosePage,getPage:()=>page,toast});
const renderExecution=executionUI(store,()=>render(true),toast);
const renderDatasets=datasetsUI(store,toast);
const renderCommunity=createCommunityUI(store,toast);
const renderMaintenance=maintenanceUI(store,toast);
const renderOperationalMaintenance=operationalMaintenanceUI(store,toast,()=>render(true));
const renderMaintenanceExperience=maintenanceExperienceUI(store,toast,{getPage:()=>page,refresh:()=>render(true)});
const renderTransfers=transfersUI(store,toast);
const renderResourceView=resourcesUI(store,{machines:MACHINES,getPage:()=>page,navigate:choosePage});
terminalUI(store,toast);
const isAdmin=()=>store.principal?.role==='admin';
const own=()=>store.users.find(u=>u.id===store.principal?.userId);
store.onAuthChange(()=>{$('#profile-dialog').close();$('#profile-form').reset();$('#profile-error').textContent='';});
const pending=u=>u.enabled&&u.role!=='admin'&&!u.approvedAt&&u.total===0;
const pendingUsers=()=>store.users.filter(pending);
const label=u=>!u.enabled?'已暂停':u.role==='admin'?'管理员':pending(u)?'待处理':u.total?'已授权':'零额度';
const dirty=()=>isAdmin()&&draft&&store.users.some(u=>u.id===selected)&&(JSON.stringify(draft.limits)!==JSON.stringify(store.get(selected).limits)||draft.total!==store.get(selected).total);
function toast(message){clearTimeout(toastTimer);const target=$('#toast'),shown=target.classList.contains('visible');target.textContent=message;target.classList.add('visible');if(!shown)target.animate(reducedMotion()?[{opacity:0},{opacity:1}]:[{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'none'}],{duration:reducedMotion()?150:220,easing:'cubic-bezier(.4,0,.2,1)'});toastTimer=setTimeout(()=>target.classList.remove('visible'),3500);}
function report(error){toast(error.message);if(error.status===401){store.principal=null;store.data=null;draft=null;render();openLogin();}}
function confirm(title,message,action){$('#confirm-title').textContent=title;$('#confirm-message').textContent=message;confirmAction=action;$('#confirm-dialog').showModal();fadeDialog($('#confirm-dialog'));}
function openLogin(){$('#login-form').reset();$('#login-error').textContent='';if(!$('#login-dialog').open)$('#login-dialog').showModal();}
function choosePage(next){if(next==='users'&&!isAdmin())next='resources';if(next===page)return;if(dirty()){toast('请先保存或撤销授权草稿。');return;}shell.route(next,()=>{page=next;history.replaceState(null,'','#'+next);render();});}
function defaultPage(){page=maintenanceActive(store.data?.operationalMaintenance)||own()?.total?'work':'resources';selected=null;draft=null;filter=pendingUsers().length?'pending':'all';history.replaceState(null,'','#'+page);}
function render(preserve=false){
  const logged=!!store.principal,admin=isAdmin(),u=own(),keepDraft=preserve&&dirty();
  if(page==='users'&&!admin)page='resources';
  document.body.classList.toggle('not-admin',!admin);
  for(const el of document.querySelectorAll('[data-admin-only]'))el.hidden=!admin;
  for(const el of document.querySelectorAll('[data-page]'))el.hidden=el.dataset.page!==page;
  for(const el of document.querySelectorAll('[data-nav]')){el.classList.toggle('active',el.dataset.nav===page);el.setAttribute('aria-current',el.dataset.nav===page?'page':'false');}
  $('#pending-count').textContent=pendingUsers().length;$('#pending-count').hidden=!pendingUsers().length;
  $('#current-account').innerHTML=logged?`<span class="current-account-name">${esc(store.principal.username)}</span><span class="current-account-role">${admin?'管理员':'普通用户'}</span>`:'尚未登录';
  $('#profile-name').textContent=logged?u?.name||store.principal.username:'未登录';$('#profile-role').textContent=admin?'管理员':'个人工作空间';
  $('#edit-profile').hidden=!logged||store.production&&store.data?.taskMetadata?.version!==1;
  if(!logged)$('#profile-dialog').close();
  $('#switch-account').textContent=logged?'退出登录':'登录';$('#refresh-state').disabled=!logged;
  const titles={me:['我的','账号、额度与个人工作区。'],transfers:['传输任务','后台传输与断点续传；不占用 GPU。'],work:['我的工作台','准备代码与环境，提交训练，跟进每一次实验。'],resources:['算力总览',''],datasets:['数据集','选定数据版本，准备到训练机器。'],community:['协作区','查看通知、反馈问题，和大家协调使用安排。'],maintenance:['历史运维记录','维护申请已停用，此处仅保留历史脚本和结果。'],users:['成员与授权','审批新成员，设置服务器权限和用卡额度。']};
  const concisePage=['community','users','maintenance'].includes(page);
  $('#page-title').textContent=titles[page][0];$('#page-description').textContent=titles[page][1];$('#page-description').hidden=concisePage;$('.help-links').hidden=concisePage;$('#breadcrumb').textContent=titles[page][0];
  const note=!logged?'登录或使用注册码注册，开始使用实验室资源。':!store.production?page==='resources'?'演示模式，无真实采集。':'本地演示：不会连接真实服务器或启动训练。':!u?.total&&page!=='community'?page==='resources'?'暂无额度，等待管理员授权。':'当前用卡额度为 0，请等待管理员授权。你仍可以查看资源和参与协作。':'';
  const monitorNotice=logged&&store.production&&store.data?.gpuq?.stale&&page!=='resources'?'监控已过期：显卡占用为未知；任务结束与额度释放以调度器核对为准。':'';
  if(concisePage){
    const mode=!logged?'请登录':!store.production?'演示':note?'额度 0':'';
    $('#mode-note').innerHTML=[mode?`<span>${mode}</span>${copyHelp('当前状态',!logged?'登录或用注册码注册后即可使用。':!store.production?'演示不会连接真实服务器或启动训练。':'获得管理员授权后才能提交训练，仍可查看资源和参与协作。','/guide/start')}`:'',monitorNotice?`<span>监控未更新</span>${copyHelp('监控未更新','显卡占用暂时未知。任务停止、额度释放以平台确认的结果为准。','/guide/troubleshooting')}`:''].filter(Boolean).join(' · ');
  }else $('#mode-note').textContent=[note,monitorNotice].filter(Boolean).join(' ');
  $('.demo-note').hidden=!note&&!monitorNotice;
  renderOperationalMaintenance();
  renderTransfers(page==='transfers');renderResources();renderExecution();renderDatasets();renderCommunity(page==='community');renderMaintenance(page==='maintenance');
  if(!keepDraft){const list=filteredUsers();if(!list.some(user=>user.id===selected))selected=list[0]?.id||null;draft=selected?store.get(selected):null;}
  if(admin){renderUsers();if(!keepDraft)renderEditor();renderTaskTable($('#all-jobs'),store.jobs,{admin,userId:store.principal.userId});}
  else{$('#editor').innerHTML='';$('#user-list').innerHTML='';$('#all-jobs').innerHTML='';}
  const activeJobs=store.jobs.filter(job=>job.userId===store.principal?.userId&&!['SUCCEEDED','FAILED','CANCELED'].includes(job.state));
  const grouped=new Map();for(const job of activeJobs){const key=job.cancelRequested?'cancel':job.state;grouped.set(key,(grouped.get(key)||0)+1);}
  const stateNames={RUNNING:['st-run','运行'],STARTING:['st-start','启动'],SUBMITTING:['st-start','提交'],PENDING:['st-queue','排队'],QUEUED:['st-queue','排队'],PREPARING_DATA:['st-prep','准备数据'],cancel:['st-cancel','正在取消'],UNKNOWN:['st-unk','待核对'],PREEMPTING:['st-cancel','正在让位'],PREEMPTED:['st-stop','让位结束']};
  const distribution=[...grouped].map(([key,count])=>{const [css,text]=stateNames[key]||['st-unk','状态未知'];return `<span class="st ${css}"><span class="g" aria-hidden="true"></span>${count} ${text}</span>`;}).join('');
  const used=u?store.usage(u.id):null,quota=u?.total;
  const quotaSlots=Number.isSafeInteger(quota)&&quota>0&&quota<=64?`<span class="wb-quota-segments" aria-hidden="true">${Array.from({length:quota},(_,i)=>`<i class="${i<used?'on':''}"></i>`).join('')}</span>`:'';
  $('#self-summary').innerHTML=logged?`<div><small>已占额度 / 上限</small><strong>${used??'—'} / ${quota??'—'}<span> 张</span></strong>${quotaSlots}</div><div><small>进行中的训练</small><strong>${activeJobs.length}<span> 项</span></strong><span class="wb-state-distribution">${distribution||'暂无进行中的训练'}</span></div><div><small>已授权服务器</small><strong>${Object.values(u?.limits||{}).filter(limit=>limit>0).length}<span> 台</span></strong><span class="wb-telemetry-note">${label(u)}</span></div>`:'';
  $('#work-title-telemetry').hidden=page!=='work'||!logged;
  $('#open-submit').hidden=page!=='work'||!logged;$('#open-submit').disabled=!store.production||store.data?.executionEnabled!==true;
  shell.update();
  renderMaintenanceExperience();
}
function renderResources(){
  const u=own(),limits=u?.limits||{};
  $('#resource-summary').textContent=u?`额度 ${u.total} 张 · ${Object.values(limits).filter(value=>value>0).length} 台已授权`:'登录后查看额度';
  $('#monitor-status').textContent=monitorSummary(store.data?.gpuq,store.production);
  $('#monitor-status').title=store.data?.gpuq?.checkedAt||'';
  renderResourceView();
}
function filteredUsers(){return [...store.users].filter(u=>filter!=='pending'||pending(u)).sort((a,b)=>Number(pending(b))-Number(pending(a))||a.username.localeCompare(b.username,'zh-CN'));}
function renderUsers(){
  const list=$('#user-list'),focused=document.activeElement,scrollTop=list.scrollTop;
  const focusedUser=list.contains(focused)?focused.closest('[data-user]')?.dataset.user:null;
  $('#filter-pending').textContent=`待处理 ${pendingUsers().length}`;$('#filter-all').textContent=`全部账号 ${store.users.length}`;
  $('#filter-pending').setAttribute('aria-pressed',String(filter==='pending'));$('#filter-all').setAttribute('aria-pressed',String(filter==='all'));
  list.innerHTML=filteredUsers().map(u=>`<button class="user-row ${u.id===selected?'selected':''}" data-user="${esc(u.id)}" aria-pressed="${u.id===selected}"><span class="avatar">${esc(u.name.slice(0,1))}</span><span class="user-details"><span class="user-name">${esc(u.name)}</span><span class="user-meta">${label(u)}${u.total?' · '+u.total+' 张':''}</span></span><span class="user-chevron">›</span></button>`).join('')||'<div class="empty">暂无待处理账号。</div>';
  list.scrollTop=scrollTop;
  if(focusedUser)for(const row of list.querySelectorAll('[data-user]'))if(row.dataset.user===focusedUser){row.focus({preventScroll:true});break;}
}
function renderEditor(){
  if(!draft){$('#editor').innerHTML='<div class="editor-empty"><h2>审批都处理好了</h2><p class="muted">切到“全部账号”可调整已有授权。</p><button class="button" data-action="invites">查看注册码</button></div>';return;}
  const u=store.get(selected),self=u.id===store.principal.userId,admin=u.role==='admin';
  const permissionsHelp=copyHelp('服务器额度','勾选服务器后才能使用，卡数不绑定具体显卡。新账号会自动出现在待处理，额度为 0，批准后才能提交训练。','/guide/start');
  const totalHelp=copyHelp('合计额度','排队也占用额度，所有服务器同时受这个上限限制。有额度仍可能需要等空卡。','/guide/queue');
  const accountHelp=()=>copyHelp('账号权限','用卡额度与管理员权限分开，管理员只能授予受信任的维护者。管理员可管理账号，并访问已启用的服务器管理终端。','/guide/start');
  const deleteHelp=copyHelp('删除条件','先暂停账号、确认没有未完成任务后才能删除，数据和历史保留。不能删除当前账号或移除最后一名管理员。','/guide/start');
  $('#editor').innerHTML=`<span class="hero-label">${pending(u)?'待审批':'成员授权'}</span>
    <div class="editor-head"><div><h2>${esc(u.name)}</h2><p class="muted"><span class="member-username">${esc(u.username)}</span> · ${label(u)}${self?' · 当前账号':''}</p></div><button class="button" data-action="reset-password">重置密码</button></div>
    <div class="editor-body">${admin?`<div class="approval-note copy-caption"><span>全部服务器 · ${capacity} 张</span>${accountHelp()}</div>`:`
      <div class="editor-save"><div><p id="policy-summary"></p><p class="save-state" id="save-state" role="status"></p></div><div><button class="button ghost" data-action="reset-draft">撤销</button><button class="button primary" data-action="save-policy">${pending(u)?'批准授权':'保存额度'}</button></div></div>
      <p class="form-error" id="policy-error" role="alert"></p>
      <div class="permission-heading"><div class="copy-caption"><h3>服务器额度</h3>${permissionsHelp}</div><button class="button" data-action="grant-full">全部最大额度</button></div>
      <div class="permissions">${MACHINES.map(m=>`<div class="permission ${draft.limits[m.id]?'granted':''}"><label class="permission-top"><input type="checkbox" data-machine="${m.id}" ${draft.limits[m.id]?'checked':''}><span>${esc(m.id)}</span><small class="permission-spec">${m.cards} × ${esc(m.model)}</small></label><div class="permission-bottom"><span class="permission-meter" data-permission-meter="${m.id}" aria-hidden="true">${Array.from({length:m.cards},()=>'<i></i>').join('')}</span><label>最多使用<input class="quota-input" type="number" min="1" max="${m.cards}" data-quota="${m.id}" value="${draft.limits[m.id]||0}" ${draft.limits[m.id]?'':'disabled'}> / ${m.cards} 张</label></div></div>`).join('')}</div>
      <div class="total-limit"><div class="copy-caption"><label for="member-total"><strong>合计额度</strong></label>${totalHelp}</div><span><input id="member-total" class="quota-input" type="number" min="0" max="${capacity}" data-quota="total" value="${draft.total}"> / ${capacity} 张</span></div>
      <div class="member-draft-note copy-caption" hidden><span>刷新会丢弃修改。</span>${copyHelp('授权草稿','自动更新会保留正在填写的草稿。关闭或刷新页面会丢弃未保存的修改。','/guide/start')}</div>`}
      <details class="account-settings"><summary>账号权限与状态</summary><div class="copy-caption"><span>管理权限</span>${accountHelp()}</div><div class="account-actions"><button class="button" data-action="role" ${self?'disabled title="不能修改当前账号"':''}>${admin?'改为普通用户':'设为管理员'}</button><button class="button" data-action="enabled" ${self?'disabled title="不能暂停当前账号"':''}>${u.enabled?'暂停账号':'恢复账号'}</button><button class="button danger" data-action="delete" ${self||u.enabled?'disabled':''} title="${self?'不能删除当前账号':u.enabled?'先暂停账号':'删除账号'}">删除账号</button>${deleteHelp}</div></details>
    </div>`;updateDirty();
}
function updateDirty(){
  const state=$('#save-state');if(state)state.textContent=dirty()?'未保存':'已保存';
  const draftNote=$('.member-draft-note');if(draftNote)draftNote.hidden=!dirty();
  const summary=$('#policy-summary');if(!summary||!draft)return;
  const valid=Number.isSafeInteger(draft.total)&&draft.total>=0&&draft.total<=capacity&&MACHINES.every(m=>draft.limits[m.id]===undefined||Number.isSafeInteger(draft.limits[m.id])&&draft.limits[m.id]>=1&&draft.limits[m.id]<=m.cards);
  summary.textContent=valid?[...MACHINES.filter(m=>draft.limits[m.id]>0).map(m=>m.id+' '+draft.limits[m.id]+' 张'),'合计 '+draft.total+' 张'].join(' · '):'额度草稿中有待校正的数值';
  for(const meter of document.querySelectorAll('[data-permission-meter]')){
    const count=draft.limits[meter.dataset.permissionMeter]||0,max=MACHINES.find(m=>m.id===meter.dataset.permissionMeter).cards;
    for(const [index,tick] of [...meter.children].entries())tick.classList.toggle('is-on',Number.isSafeInteger(count)&&count>=0&&count<=max&&index<count);
  }
}
async function refresh(){if(refreshing||!store.principal)return;refreshing=true;shell.syncStatus('syncing');try{await store.refresh();render(true);shell.syncStatus('ready',Date.now());if($('#invites-dialog').open)await loadInvites();}catch(e){shell.syncStatus('failed');report(e);}finally{refreshing=false;}}
async function loadInvites(){const result=await store.call('invites.list');inviteCode=result.code;const i=result.invitations[0];$('#invites-content').innerHTML=`<section class="invite-card"><div class="invite-heading"><h3>当前注册码</h3><span class="badge ${i.available?'active':'pending'}">${i.available?'可用':'未启用'}</span></div>${copyHelp('注册码','注册码不是登录密码，新账号额度为 0，需要管理员授权，不会获得管理员权限。复制给同学即可注册，换新或停用只影响后续注册。','/guide/start')}${inviteCode?`<label class="field">注册码<input id="current-invite" readonly spellcheck="false" value="${esc(inviteCode)}"></label><button class="button" data-action="copy-invite">复制注册码</button>`:`<p class="approval-note">${i.available?'旧码无法显示，请换新一次。':'生成一个注册码后即可邀请同学。'}</p>`}<p class="muted">已注册 ${i.uses} 个账号</p><div class="invite-actions"><button class="button primary" data-action="rotate-invite">${i.createdAt?'换新注册码':'生成注册码'}</button><button class="button danger" data-action="disable-invite" ${i.enabled?'':'disabled'}>停用注册</button></div></section>`;}
async function guardedChange(action){if(dirty()){toast('请先保存或撤销额度草稿。');return;}await action();}
document.addEventListener('click',async event=>{
  const b=event.target.closest('button,a[data-nav]');if(!b||b.disabled)return;
  if(b.dataset.nav){event.preventDefault();choosePage(b.dataset.nav);return;}
  if(b.dataset.close){$('#'+b.dataset.close).close();return;}
  if(b.dataset.user){await guardedChange(()=>{selected=b.dataset.user;draft=store.get(selected);renderUsers();renderEditor();});return;}
  if(b.dataset.useMachine){
    const id=b.dataset.useMachine;if(!store.principal||!store.data?.machines?.some(machine=>machine.id===id)){toast('未获此服务器授权，请刷新核对。');return;}
    choosePage('work');if(page!=='work')return;
    const target=$('[name=workspace-machine]');if(target){target.value=id;target.dispatchEvent(new Event('change',{bubbles:true}));}return;
  }
  const action=b.dataset.action||b.id;
  try{switch(action){
    case 'filter-pending':case 'filter-all':await guardedChange(()=>{filter=action==='filter-pending'?'pending':'all';selected=null;render();});break;
    case 'refresh-state':await refresh();toast('已更新');break;
    case 'switch-account':if(store.principal)await store.logout();selected=null;draft=null;inviteCode=null;render();openLogin();break;
    case 'open-register':$('#login-dialog').close();$('#register-form').reset();$('#register-error').textContent='';$('#register-dialog').showModal();break;
    case 'back-to-login':$('#register-dialog').close();openLogin();break;
    case 'invites':$('#invites-error').textContent='';await loadInvites();$('#invites-dialog').showModal();break;
    case 'copy-invite':try{await navigator.clipboard.writeText(inviteCode);toast('注册码已复制');}catch{$('#current-invite').select();toast('请复制选中的注册码');}break;
    case 'rotate-invite':confirm('换一个新注册码？','旧码立即失效；已有账号、额度和训练不受影响。',async()=>{await store.call('invites.rotate',{role:'member'});await loadInvites();toast('新注册码已生效');});break;
    case 'disable-invite':confirm('停用新用户注册？','已有用户仍能正常登录和训练。',async()=>{await store.call('invites.disable',{role:'member'});await loadInvites();});break;
    case 'reset-draft':draft=store.get(selected);renderEditor();break;
    case 'save-policy':{if(pending(store.get(selected))&&draft.total<1)throw Error('批准时请至少选择一台机器并分配 1 张卡。');b.disabled=true;try{await store.save(selected,draft);draft=null;render();toast('额度已保存，用户端会自动更新');}catch(e){$('#policy-error').textContent=e.message;}finally{b.disabled=false;}break;}
    case 'grant-full':confirm('分配全部机器最大额度？','仍是普通用户，不会获得账号管理或宿主机 root 权限。',async()=>{await store.call('policy.full',{userId:selected,policyVersion:store.get(selected).policyVersion});draft=null;render();toast('已批准全部用卡额度');});break;
    case 'reset-password':$('#password-form').reset();$('#password-error').textContent='';$('#password-account').textContent=`账号：${store.get(selected).username}`;$('#password-dialog').showModal();break;
    case 'role':await guardedChange(()=>{const u=store.get(selected),role=u.role==='admin'?'member':'admin';confirm(role==='admin'?'授予管理员权限？':'改为普通用户？',role==='admin'?'可管理全部账号，并在已启用节点访问宿主机 root。只授予完全受信任的维护者。':'恢复个人额度并撤销旧登录。',async()=>{await store.setRole(u.id,role);draft=null;render();});});break;
    case 'enabled':await guardedChange(()=>{const u=store.get(selected);confirm(u.enabled?'暂停账号？':'恢复账号？','暂停会撤销登录并阻止新任务，但不会结束已有训练。',async()=>{await store.setEnabled(u.id,!u.enabled);draft=null;render();});});break;
    case 'delete':{const u=store.get(selected);confirm(`删除 ${u.username}？`,'删除登录资格和授权，保留任务历史与工作区文件。',async()=>{await store.call('users.delete',{userId:u.id});selected=null;draft=null;render();toast('账号已删除');});break;}
    case 'confirm-action':{const fn=confirmAction;confirmAction=null;b.disabled=true;try{await fn?.();$('#confirm-dialog').close();}finally{b.disabled=false;}break;}
  }}catch(e){report(e);}
});
document.addEventListener('change',event=>{const id=event.target.dataset.machine;if(!id||!draft)return;if(event.target.checked){draft.limits[id]=1;if(!draft.total)draft.total=1;}else{delete draft.limits[id];draft.total=Math.min(draft.total,Object.values(draft.limits).reduce((a,b)=>a+b,0));}renderEditor();$(`[data-machine="${id}"]`).focus();});
document.addEventListener('input',event=>{const key=event.target.dataset.quota;if(!key||!draft)return;const value=event.target.value===''?NaN:Number(event.target.value);if(key==='total')draft.total=value;else draft.limits[key]=value;updateDirty();});
$('#password-form').addEventListener('submit',async event=>{event.preventDefault();const b=event.submitter;b.disabled=true;try{const self=selected===store.principal.userId;await store.reset(selected,new FormData(event.target).get('password'));event.target.reset();$('#password-dialog').close();toast('密码已重置，旧登录已失效');if(self){await store.logout().catch(()=>{});render();openLogin();}}catch(e){$('#password-error').textContent=e.message;}finally{b.disabled=false;}});
$('#edit-profile').addEventListener('click',()=>{$('#profile-form [name=profile-name]').value=own()?.name||store.principal.username;$('#profile-error').textContent='';$('#profile-dialog').showModal();});
$('#profile-form').addEventListener('submit',async event=>{event.preventDefault();const b=event.submitter;b.disabled=true;try{await store.call('profile.update',{name:new FormData(event.target).get('profile-name')});$('#profile-dialog').close();render(true);toast('姓名已保存；新任务记录提交时姓名。');}catch(e){$('#profile-error').textContent=e.message;}finally{b.disabled=false;}});
$('#login-form').addEventListener('submit',async event=>{event.preventDefault();const b=event.submitter,data=new FormData(event.target);b.disabled=true;try{await store.login(data.get('username'),data.get('password'));event.target.reset();$('#login-dialog').close();defaultPage();render();shell.syncStatus('ready',Date.now());}catch(e){$('#login-error').textContent=e.message;}finally{b.disabled=false;}});
$('#register-form').addEventListener('submit',async event=>{event.preventDefault();const b=event.submitter,data=new FormData(event.target);b.disabled=true;$('#register-error').textContent='';try{if(data.get('password')!==data.get('confirm'))throw Error('两次密码不一致。');await store.register(data.get('username'),data.get('password'),data.get('invite'),data.get('signup-name')||undefined);await store.login(data.get('username'),data.get('password'));event.target.reset();$('#register-dialog').close();defaultPage();render();toast('注册成功，等待管理员分配额度');}catch(e){$('#register-error').textContent=e.message;}finally{b.disabled=false;}});
$('#invites-dialog').addEventListener('close',()=>{inviteCode=null;$('#invites-content').innerHTML='';});
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
const publicGuide=$('.guide-link'),guideHome=publicGuide.parentNode,guideAfter=publicGuide.nextSibling;
function syncAuthGuide(){
  const active=$('#register-dialog').open?$('#register-dialog'):$('#login-dialog').open?$('#login-dialog'):null;
  if(active)active.querySelector('[data-auth-guide-slot]').append(publicGuide);
  else guideHome.insertBefore(publicGuide,guideAfter);
}
const authGuideObserver=new MutationObserver(syncAuthGuide);
for(const dialog of [$('#login-dialog'),$('#register-dialog')])authGuideObserver.observe(dialog,{attributes:true,attributeFilter:['open']});
installAuthentication(MACHINES);
const initialHash=location.hash.slice(1);if(store.principal){defaultPage();if(['work','resources','datasets','transfers','community','maintenance','users','me'].includes(initialHash))page=initialHash;}render();if(store.principal)shell.syncStatus('ready',Date.now());else openLogin();
const poll=setInterval(()=>{if(!document.hidden)refresh();},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(['work','resources','datasets','transfers','community','maintenance','users','me'].includes(next)&&next!==page)choosePage(next);});
addEventListener('pagehide',()=>clearInterval(poll),{once:true});
