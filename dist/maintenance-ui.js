import {createSubmissionKeys} from './community-ui.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const done=new Set(['RETURNED','WITHDRAWN','SUCCEEDED','FAILED','CANCELED','TIMED_OUT']);
const labels={PENDING:'待管理员确认',RETURNED:'已退回',WITHDRAWN:'已撤回',DISPATCHING:'派发待核对',RUNNING:'执行中',CANCELING:'停止待确认',SUCCEEDED:'已完成',FAILED:'执行失败',CANCELED:'已停止',TIMED_OUT:'已超时',UNKNOWN:'结果待核对'};

export function maintenanceUI(store,toast){
  const host=document.querySelector('#page-maintenance'),keys=createSubmissionKeys();
  let identity=null,generation=0,selectionSerial=0,visible=false,ready=false,busy=false,loading=false,selected=null,preview=null,cursor=null;
  const same=stamp=>stamp===generation&&identity===store.principal?.userId;
  const q=selector=>host.querySelector(selector);
  function reset(){generation++;selectionSerial++;identity=null;ready=false;busy=false;loading=false;selected=null;preview=null;cursor=null;keys.reset();host.replaceChildren();}
  store.onAuthChange(reset);
  function build(){
    host.innerHTML=`<div class="maintenance-layout"><section class="panel maintenance-composer"><h2>申请特殊管理操作</h2><p class="muted">日常训练无需审批。这里仅提交申请，不执行脚本、不授予 root。不要填写密码或令牌。</p>
      <form id="maintenance-create"><label class="field">目标机器<select name="maintenance-machine" required><option value="">请选择</option></select></label>
      <label class="field">标题<input name="maintenance-title" maxlength="120" required></label><label class="field">申请原因<textarea name="maintenance-reason" maxlength="2000" rows="3" required></textarea></label>
      <label class="field">脚本正文<textarea name="maintenance-script" rows="7" spellcheck="false" required placeholder="例如检查系统库；最多 8 KiB，管理员确认后以 root 执行"></textarea></label>
      <div class="maintenance-pair"><label class="field">工作目录<input name="maintenance-cwd" value="/root" required></label><label class="field">超时（秒）<input name="maintenance-timeout" type="number" min="1" max="86400" value="300" required></label></div>
      <label class="field">引用旧申请（可选）<input name="maintenance-parent" placeholder="退回后补充内容，用新申请引用旧编号"></label><p id="maintenance-create-error" class="form-error" role="status"></p><button type="submit" class="button primary">提交申请</button></form></section>
      <section class="panel maintenance-history"><div class="maintenance-toolbar"><h2>维护申请</h2><button class="button" id="maintenance-refresh">刷新列表</button></div><p id="maintenance-list-error" class="form-error" role="status"></p><div id="maintenance-list"></div><button class="button" id="maintenance-more" hidden>下一页</button><div id="maintenance-detail"></div></section></div>`;
    q('#maintenance-create').addEventListener('submit',create);
    q('#maintenance-refresh').addEventListener('click',()=>{cursor=null;load();});
    q('#maintenance-more').addEventListener('click',()=>load(cursor));ready=true;
  }
  async function load(next){
    if(!ready||loading||!visible)return;loading=true;const stamp=generation;
    try{
      const result=await store.call('maintenance.list',next?{cursor:next}:{});if(!same(stamp))return;
      cursor=result.nextCursor;q('#maintenance-more').hidden=!cursor;q('#maintenance-list-error').textContent='';
      q('#maintenance-list').innerHTML=result.items.map(r=>`<button class="maintenance-row" data-id="${esc(r.id)}"><strong>${esc(r.title)}</strong><span>${esc(r.machine)} · ${esc(r.owner.username)} · ${esc(labels[r.state]||r.state)}</span><small>${esc(r.id)}</small></button>`).join('')||'<p class="empty">暂无维护申请。</p>';
      for(const node of q('#maintenance-list').querySelectorAll('[data-id]'))node.addEventListener('click',()=>show(node.dataset.id));
      if(selected&&!busy&&!preview)await show(selected.id);
    }catch(error){if(same(stamp))q('#maintenance-list-error').textContent=error.message;}
    finally{if(same(stamp))loading=false;}
  }
  async function create(event){
    event.preventDefault();if(busy)return;busy=true;const stamp=generation,form=event.currentTarget;
    const values=new FormData(form),payload={machine:values.get('maintenance-machine'),title:values.get('maintenance-title'),reason:values.get('maintenance-reason'),script:values.get('maintenance-script'),cwd:values.get('maintenance-cwd'),timeoutSec:Number(values.get('maintenance-timeout')),...(values.get('maintenance-parent')?{parentId:values.get('maintenance-parent')}:{})};
    const button=form.querySelector('[type=submit]');button.disabled=true;
    try{
      const request=keys.request('maintenance',payload),result=await store.call('maintenance.create',request);if(!same(stamp))return;
      keys.confirmed('maintenance');form.reset();q('#maintenance-create-error').textContent='';selected=result;preview=null;detail();toast('申请已提交，尚未执行。');await load();
    }catch(error){if(same(stamp)){if(!error.status||error.status>=500)keys.uncertain('maintenance');q('#maintenance-create-error').textContent=keys.hasUncertain('maintenance')?'提交结果未确认，请保留原内容再次提交，沿用原提交键。':error.message;}}
    finally{if(same(stamp)){busy=false;button.disabled=false;}}
  }
  async function show(id){
    if(busy)return;const stamp=generation,sequence=++selectionSerial;
    try{const result=await store.call('maintenance.get',{id});if(!same(stamp)||busy||sequence!==selectionSerial)return;selected=result;preview=null;detail();}
    catch(error){if(same(stamp))q('#maintenance-list-error').textContent=error.message;}
  }
  function detail(){
    if(!selected)return;const r=selected,admin=store.principal.role==='admin';
    q('#maintenance-detail').innerHTML=`<article class="maintenance-detail"><h3>${esc(r.title)}</h3><p>${esc(r.machine)} · ${esc(r.owner.username)} · ${esc(labels[r.state]||r.state)} · v${r.revision}</p><p class="muted">${esc(r.id)}</p>
      <p>申请原因：${esc(r.reason)}</p><p>目录：${esc(r.cwd)} · 超时 ${r.timeoutSec}s</p><p class="maintenance-hash">脚本 SHA256：${esc(r.scriptSha256)}</p><pre tabindex="0">${esc(r.script)}</pre>
      ${r.execution?`<p class="maintenance-hash">原执行键：${esc(r.execution.id)}（只用于核对原操作）</p>`:''}
      ${r.decision?`<p>处理人：${esc(r.decision.by.username)}${r.decision.reason?' · 退回理由：'+esc(r.decision.reason):''}</p>`:''}${r.error?`<p role="status">${esc(r.error)}</p>`:''}
      ${r.result?`<p>上次节点回执：${esc(labels[r.result.state]||r.result.state)} · 退出码 ${r.result.exitCode??'未确认'} · ${esc(r.result.checkedAt)}</p><h4>标准输出</h4><pre tabindex="0">${esc(r.result.stdout)}</pre><h4>错误输出</h4><pre tabindex="0">${esc(r.result.stderr)}</pre>${r.result.truncated.stdout||r.result.truncated.stderr?'<p>输出已截断，每路最多 64 KiB。</p>':''}`:''}
      <div id="maintenance-impact"></div><p id="maintenance-action-error" class="form-error" role="status"></p><div class="maintenance-actions">
      <button class="button" data-maintenance="refresh">核对状态</button>
      ${r.state==='PENDING'&&r.owner.id===store.principal.userId?'<button class="button" data-maintenance="withdraw">撤回申请</button>':''}
      ${r.state==='PENDING'&&admin?'<button class="button" data-maintenance="preview">预览批准操作与占用</button><button class="button danger" data-maintenance="approve" disabled>批准并执行 ROOT 操作</button><button class="button" data-maintenance="return">退回并填写理由</button>':''}
      ${!done.has(r.state)&&r.state!=='PENDING'&&admin?'<button class="button danger" data-maintenance="cancel">停止原操作（不回滚）</button>':''}</div></article>`;
    for(const node of q('#maintenance-detail').querySelectorAll('[data-maintenance]'))node.addEventListener('click',()=>act(node.dataset.maintenance));
  }
  async function act(action){
    if(busy||!selected)return;if(action==='refresh'){await show(selected.id);return;}
    const stamp=generation,row=selected;let args={id:row.id,revision:row.revision};
    if(action==='return'){const reason=window.prompt('请填写退回理由：');if(reason===null)return;if(!reason.trim()){q('#maintenance-action-error').textContent='退回理由必填。';return;}args.reason=reason;}
    if(action==='approve'){
      if(!preview)return;let acknowledgeUnknown=false;
      if(!preview.impact.complete){if(!q('#maintenance-ack')?.checked){q('#maintenance-action-error').textContent='占用不完整，需要明确勾选仍执行。';return;}acknowledgeUnknown=true;}
      if(!window.confirm(`确认在 ${row.machine} 以 ROOT 执行这份脚本？可能影响所有用户，失败不会回滚。`))return;
      args={id:row.id,revision:preview.request.revision,previewToken:preview.previewToken,acknowledgeUnknown};
    }
    if(['withdraw','cancel'].includes(action)&&!window.confirm(action==='withdraw'?'撤回这项尚未批准的申请？':'仅停止这项原操作，不能撤销已产生的修改。确认停止？'))return;
    busy=true;for(const button of q('#maintenance-detail').querySelectorAll('button'))button.disabled=true;
    try{
      const result=await store.call('maintenance.'+action,action==='preview'?{id:row.id}:args);if(!same(stamp))return;
      if(action==='preview'){
        preview=result;selected=result.request;detail();
        q('#maintenance-impact').innerHTML=`<h4>批准前占用快照（预览120秒有效）</h4><p>${result.impact.complete?'占用信息完整':'占用信息不完整，不代表空闲'}</p><pre tabindex="0">${esc(JSON.stringify(result.impact,null,2))}</pre><p>脚本引用的外部文件／网络依赖不被冻结，请核对。执行输出将反馈申请者，不应含秘密。审批后断网也可能已开始执行。</p>${result.impact.complete?'':'<label><input id="maintenance-ack" type="checkbox">我确认占用信息不完整，仍执行这项 ROOT 操作</label>'}`;
      }else{selected=result;preview=null;detail();toast(action==='approve'?'审批已确认，请查看实际执行状态。':action==='return'?'已退回，理由已反馈。':'状态已更新。');}
    }catch(error){if(same(stamp)){preview=null;detail();q('#maintenance-action-error').textContent=error.message+' 请核对状态；不要另建申请盲目重跑。';}}
    finally{if(same(stamp)){busy=false;for(const button of q('#maintenance-detail').querySelectorAll('button'))button.disabled=button.dataset.maintenance==='approve'&&!preview;}}
  }
  return active=>{
    const enabled=store.production===true&&store.data?.maintenance?.version===1&&!!store.principal;
    const nav=document.querySelector('[data-nav=maintenance]');nav.hidden=!enabled;
    if(identity!==store.principal?.userId){reset();identity=store.principal?.userId;}
    visible=active&&enabled;if(!enabled)return;
    if(!ready)build();
    const select=q('[name=maintenance-machine]'),choice=select.value,owner=store.users.find(u=>u.id===store.principal.userId);
    const machines=(store.data.machines||[]).filter(m=>owner?.limits[m.id]);
    if(JSON.stringify([...select.options].slice(1).map(o=>o.value))!==JSON.stringify(machines.map(m=>m.id))){select.innerHTML='<option value="">请选择</option>'+machines.map(m=>`<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('');select.value=choice;}
    if(visible)load();
  };
}
