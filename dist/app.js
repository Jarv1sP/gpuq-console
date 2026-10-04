import {MACHINES} from './model.js';
import {DemoClient} from './client.js';
import {executionUI,renderTaskTable} from './execution-ui.js';
import {terminalUI} from './terminal-ui.js';
import {resourceCards,monitorSummary} from './resources-ui.js';
import {datasetsUI} from './datasets-ui.js';
import {createCommunityUI} from './community-ui.js';
import {maintenanceUI,operationalMaintenanceUI} from './maintenance-ui.js';
import {transfersUI} from './transfers-ui.js';
const store=await DemoClient.create(),$=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const capacity=MACHINES.reduce((n,m)=>n+m.cards,0);
let page='work',selected=null,draft=null,filter='pending',toastTimer,confirmAction,inviteCode=null,refreshing=false;
const renderExecution=executionUI(store,()=>render(true),toast);
const renderDatasets=datasetsUI(store,toast);
const renderCommunity=createCommunityUI(store,toast);
const renderMaintenance=maintenanceUI(store,toast);
const renderOperationalMaintenance=operationalMaintenanceUI(store,toast);
const renderTransfers=transfersUI(store,toast);
terminalUI(store,toast);
const isAdmin=()=>store.principal?.role==='admin';
const own=()=>store.users.find(u=>u.id===store.principal?.userId);
store.onAuthChange(()=>{$('#profile-dialog').close();$('#profile-form').reset();$('#profile-error').textContent='';});
const pending=u=>u.enabled&&u.role!=='admin'&&!u.approvedAt&&u.total===0;
const pendingUsers=()=>store.users.filter(pending);
const label=u=>!u.enabled?'已暂停':u.role==='admin'?'管理员':pending(u)?'待处理':u.total?'已授权':'零额度';
const dirty=()=>isAdmin()&&draft&&store.users.some(u=>u.id===selected)&&(JSON.stringify(draft.limits)!==JSON.stringify(store.get(selected).limits)||draft.total!==store.get(selected).total);
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}
function report(error){toast(error.message);if(error.status===401){store.principal=null;store.data=null;draft=null;render();openLogin();}}
function confirm(title,message,action){$('#confirm-title').textContent=title;$('#confirm-message').textContent=message;confirmAction=action;$('#confirm-dialog').showModal();}
function openLogin(){$('#login-form').reset();$('#login-error').textContent='';if(!$('#login-dialog').open)$('#login-dialog').showModal();}
function choosePage(next){if(next==='users'&&!isAdmin())next='resources';if(next===page)return;if(dirty()){toast('请先保存或撤销授权草稿。');return;}page=next;history.replaceState(null,'','#'+next);render();}
function defaultPage(){page=own()?.total?'work':'resources';selected=null;draft=null;filter=pendingUsers().length?'pending':'all';history.replaceState(null,'','#'+page);}
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
  const titles={transfers:['传输任务','后台传输与断点续传；不占用 GPU。'],work:['我的工作台','准备代码与环境，提交训练，跟进每一次实验。'],resources:['算力总览','查看每张 GPU 的使用情况，选择适合的服务器。'],datasets:['数据集','选定数据版本，准备到训练机器。'],community:['协作区','查看通知、反馈问题，和大家协调使用安排。'],maintenance:['历史运维记录','维护申请已停用，此处仅保留历史脚本和结果。'],users:['成员与授权','审批新成员，设置服务器权限和用卡额度。']};
  $('#page-title').textContent=titles[page][0];$('#page-description').textContent=titles[page][1];$('#breadcrumb').textContent=titles[page][0];
  const note=!logged?'登录或使用注册码注册，开始使用实验室资源。':!store.production?'本地演示：不会连接真实服务器或启动训练。':!u?.total&&page!=='community'?'当前用卡额度为 0，请等待管理员授权。你仍可以查看资源和参与协作。':'';
  $('#mode-note').textContent=note;$('.demo-note').hidden=!note;
  renderOperationalMaintenance();
  renderTransfers(page==='transfers');renderResources();renderExecution();renderDatasets();renderCommunity(page==='community');renderMaintenance(page==='maintenance');
  if(!keepDraft){const list=filteredUsers();if(!list.some(user=>user.id===selected))selected=list[0]?.id||null;draft=selected?store.get(selected):null;}
  if(admin){renderUsers();if(!keepDraft)renderEditor();renderTaskTable($('#all-jobs'),store.jobs,{admin,userId:store.principal.userId});}
  else{$('#editor').innerHTML='';$('#user-list').innerHTML='';$('#all-jobs').innerHTML='';}
  $('#self-summary').innerHTML=logged?`<div><small>已授权服务器</small><strong>${Object.keys(u?.limits||{}).length}</strong></div><div><small>已占额度 / 上限</small><strong>${store.usage(u.id)} / ${u.total}<span> 张</span></strong></div><div><small>账号状态</small><strong class="summary-status">${label(u)}</strong></div>`:'<p class="muted">登录后查看自己的额度和任务。</p>';
}
function renderResources(){
  const u=own(),limits=u?.limits||{},grid=$('#machine-grid');
  const expanded=new Set([...grid.querySelectorAll('details[open][data-resource-detail]')].map(el=>el.dataset.resourceDetail));
  const focused=document.activeElement?.closest('details[data-resource-detail]')?.dataset.resourceDetail;
  $('#resource-summary').textContent=u?`我的额度：${u.total} 张 · 已授权 ${Object.keys(limits).length} 台 · 实验室共 ${capacity} 张`:'登录后查看个人额度';
  $('#monitor-status').textContent=monitorSummary(store.data?.gpuq,store.production);
  grid.innerHTML=resourceCards({machines:MACHINES,limits,snapshot:store.data?.gpuq,admin:isAdmin(),production:store.production});
  for(const el of grid.querySelectorAll('details[data-resource-detail]')){el.open=expanded.has(el.dataset.resourceDetail);if(el.dataset.resourceDetail===focused)el.querySelector('summary').focus({preventScroll:true});}
}
function filteredUsers(){return [...store.users].filter(u=>filter!=='pending'||pending(u)).sort((a,b)=>Number(pending(b))-Number(pending(a))||a.username.localeCompare(b.username,'zh-CN'));}
function renderUsers(){
  const list=$('#user-list'),focused=document.activeElement;
  const focusedUser=list.contains(focused)?focused.closest('[data-user]')?.dataset.user:null;
  $('#filter-pending').textContent=`待处理 ${pendingUsers().length}`;$('#filter-all').textContent=`全部账号 ${store.users.length}`;
  $('#filter-pending').setAttribute('aria-pressed',String(filter==='pending'));$('#filter-all').setAttribute('aria-pressed',String(filter==='all'));
  list.innerHTML=filteredUsers().map(u=>`<button class="user-row ${u.id===selected?'selected':''}" data-user="${esc(u.id)}" aria-pressed="${u.id===selected}"><span class="avatar">${esc(u.name.slice(0,1))}</span><span class="user-details"><span class="user-name">${esc(u.name)}</span><span class="user-meta">${label(u)}${u.total?' · '+u.total+' 张':''}</span></span><span class="user-chevron">›</span></button>`).join('')||'<div class="empty">没有待处理的新账号。<br>把注册码发给同学即可自行注册。</div>';
  if(focusedUser)for(const row of list.querySelectorAll('[data-user]'))if(row.dataset.user===focusedUser){row.focus({preventScroll:true});break;}
}
function renderEditor(){
  if(!draft){$('#editor').innerHTML='<div class="editor-empty"><h2>审批都处理好了</h2><p class="muted">新注册账号会自动出现在这里。也可以切到“全部账号”调整已有授权。</p><button class="button" data-action="invites">查看注册码</button></div>';return;}
  const u=store.get(selected),self=u.id===store.principal.userId,admin=u.role==='admin';
  $('#editor').innerHTML=`<div class="editor-head"><div><h2>${esc(u.name)}</h2><p class="muted">${label(u)}${self?' · 当前账号':''}</p></div><button class="button" data-action="reset-password">重置密码</button></div><div class="editor-body">${admin?'<div class="approval-note">管理员自动拥有所有机器与最大额度。此角色还可管理用户，并访问已启用的宿主机 root 终端。</div>':`<h3>分配机器与卡数</h3><p class="subtext">勾选机器并填写并发上限；没有勾选的机器不能使用。</p><div class="permissions">${MACHINES.map(m=>`<div class="permission ${draft.limits[m.id]?'granted':''}"><label class="permission-top"><input type="checkbox" data-machine="${m.id}" ${draft.limits[m.id]?'checked':''}><span>${esc(m.id)}</span></label><p class="permission-spec">${m.cards} × ${esc(m.model)}</p><label class="permission-bottom">最多使用<input class="quota-input" type="number" min="1" max="${m.cards}" data-quota="${m.id}" value="${draft.limits[m.id]||1}" ${draft.limits[m.id]?'':'disabled'}>张</label></div>`).join('')}</div><label class="total-limit"><span><strong>所有机器合计上限</strong><small class="subtext">不是预留卡位；没有空闲 GPU 会排队。</small></span><span><input class="quota-input" type="number" min="0" max="${capacity}" data-quota="total" value="${draft.total}"> 张</span></label><div class="editor-save"><button class="button" data-action="grant-full">全部机器最大额度</button><div><button class="button ghost" data-action="reset-draft">撤销</button><button class="button primary" data-action="save-policy">${pending(u)?'批准授权':'保存额度'}</button></div></div><p class="form-error" id="policy-error" role="alert"></p><p class="save-state" id="save-state"></p>`}<details class="account-settings"><summary>账号权限与状态</summary><p class="muted">最大用卡额度 ≠ 管理员。只有完全受信任的维护者才应成为管理员。</p><div class="account-actions"><button class="button" data-action="role" ${self?'disabled':''}>${admin?'改为普通用户':'设为管理员'}</button><button class="button" data-action="enabled" ${self?'disabled':''}>${u.enabled?'暂停账号':'恢复账号'}</button><button class="button danger" data-action="delete" ${self||u.enabled?'disabled':''}>删除账号</button></div><small class="muted">先暂停、确认没有未完成任务后才能删除；数据和历史保留。最后一名管理员不能移除。</small></details></div>`;updateDirty();
}
function updateDirty(){const el=$('#save-state');if(el)el.textContent=dirty()?'有未保存的额度修改':'当前额度已保存';}
async function refresh(){if(refreshing||!store.principal)return;refreshing=true;try{await store.refresh();render(true);if($('#invites-dialog').open)await loadInvites();}catch(e){report(e);}finally{refreshing=false;}}
async function loadInvites(){const result=await store.call('invites.list');inviteCode=result.code;const i=result.invitations[0];$('#invites-content').innerHTML=`<section class="invite-card"><div class="invite-heading"><h3>当前注册码</h3><span class="badge ${i.available?'active':'pending'}">${i.available?'可用':'未启用'}</span></div><p class="muted">新用户用此码自行注册；初始额度为 0，管理员随后审批。不会授予管理员权限。</p>${inviteCode?`<label class="field">注册码<input id="current-invite" readonly spellcheck="false" value="${esc(inviteCode)}"></label><button class="button" data-action="copy-invite">复制注册码</button>`:`<p class="approval-note">${i.available?'旧注册码仅有摘要，无法显示。请换新一次；已有账号不受影响。':'生成一个注册码后即可邀请同学。'}</p>`}<p class="muted">本码已注册 ${i.uses} 个账号。管理员重新打开此页仍可查看当前有效码。</p><div class="invite-actions"><button class="button primary" data-action="rotate-invite">${i.createdAt?'换新注册码':'生成注册码'}</button><button class="button danger" data-action="disable-invite" ${i.enabled?'':'disabled'}>停用注册</button></div></section>`;}
async function guardedChange(action){if(dirty()){toast('请先保存或撤销额度草稿。');return;}await action();}
document.addEventListener('click',async event=>{
  const b=event.target.closest('button,a[data-nav]');if(!b||b.disabled)return;
  if(b.dataset.nav){event.preventDefault();choosePage(b.dataset.nav);return;}
  if(b.dataset.close){$('#'+b.dataset.close).close();return;}
  if(b.dataset.user){await guardedChange(()=>{selected=b.dataset.user;draft=store.get(selected);renderUsers();renderEditor();});return;}
  if(b.dataset.useMachine){choosePage('work');for(const name of ['terminal-machine','machine','file-machine']){const el=$(`[name=${name}]`);if(el)el.value=b.dataset.useMachine;}return;}
  const action=b.dataset.action||b.id;
  try{switch(action){
    case 'filter-pending':case 'filter-all':await guardedChange(()=>{filter=action==='filter-pending'?'pending':'all';selected=null;render();});break;
    case 'refresh-state':await refresh();toast('已更新');break;
    case 'switch-account':await guardedChange(async()=>{if(store.principal)await store.logout();selected=null;draft=null;inviteCode=null;render();openLogin();});break;
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
$('#login-form').addEventListener('submit',async event=>{event.preventDefault();const b=event.submitter,data=new FormData(event.target);b.disabled=true;try{await store.login(data.get('username'),data.get('password'));event.target.reset();$('#login-dialog').close();defaultPage();render();}catch(e){$('#login-error').textContent=e.message;}finally{b.disabled=false;}});
$('#register-form').addEventListener('submit',async event=>{event.preventDefault();const b=event.submitter,data=new FormData(event.target);b.disabled=true;$('#register-error').textContent='';try{if(data.get('password')!==data.get('confirm'))throw Error('两次密码不一致。');await store.register(data.get('username'),data.get('password'),data.get('invite'),data.get('signup-name')||undefined);await store.login(data.get('username'),data.get('password'));event.target.reset();$('#register-dialog').close();defaultPage();render();toast('注册成功，等待管理员分配额度');}catch(e){$('#register-error').textContent=e.message;}finally{b.disabled=false;}});
$('#invites-dialog').addEventListener('close',()=>{inviteCode=null;$('#invites-content').innerHTML='';});
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
const initialHash=location.hash.slice(1);if(store.principal){defaultPage();if(['work','resources','datasets','transfers','community','maintenance','users'].includes(initialHash))page=initialHash;}render();if(!store.principal)openLogin();
const poll=setInterval(()=>{if(!document.hidden)refresh();},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(['work','resources','datasets','transfers','community','maintenance','users'].includes(next)&&next!==page)choosePage(next);});
addEventListener('pagehide',()=>clearInterval(poll),{once:true});
