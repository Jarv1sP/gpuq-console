// Compatibility view for old bookmarks. It has no mutation controls.
const visible=v=>String(v??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>c==='\n'?c:'\\u{'+c.codePointAt(0).toString(16).padStart(4,'0')+'}');
const esc=v=>visible(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={PENDING:'未执行（流程已停用）',RETURNED:'已退回',WITHDRAWN:'已撤回',DISPATCHING:'原执行待核对',RUNNING:'原操作执行中',CANCELING:'原停止结果待核对',SUCCEEDED:'已完成',FAILED:'执行失败',CANCELED:'已停止',TIMED_OUT:'已超时',UNKNOWN:'原结果待核对'};
export function maintenanceUI(store){
  const host=document.querySelector('#page-maintenance');
  let identity=null,generation=0,selectionSerial=0,active=false,ready=false,loading=false,cursor=null;
  const same=stamp=>stamp===generation&&identity===store.principal?.userId;
  const q=selector=>host?.querySelector(selector);
  function reset(){generation++;selectionSerial++;identity=null;ready=false;loading=false;cursor=null;host?.replaceChildren();}
  store.onAuthChange(reset);
  function build(){
    host.innerHTML=`<section class="panel maintenance-history"><div class="maintenance-toolbar"><h2>历史运维记录</h2><button class="button" id="maintenance-refresh">刷新</button></div>
      <p class="muted">维护申请已停用。历史脚本和结果仅供查阅，未批准的申请不会执行；已开始的操作不会因此停止。</p>
      <p id="maintenance-list-error" class="form-error" role="status"></p><div id="maintenance-list"></div><button class="button" id="maintenance-more" hidden>下一页</button><div id="maintenance-detail"></div></section>`;
    q('#maintenance-refresh').addEventListener('click',()=>load());q('#maintenance-more').addEventListener('click',()=>load(cursor));ready=true;
  }
  async function load(next){
    if(!ready||loading||!active)return;loading=true;const stamp=generation;
    try{
      const result=await store.call('maintenance.list',next?{cursor:next}:{});if(!same(stamp))return;
      cursor=result.nextCursor;q('#maintenance-more').hidden=!cursor;q('#maintenance-list-error').textContent='';
      q('#maintenance-list').innerHTML=result.items.map(r=>`<button class="maintenance-row" data-id="${esc(r.id)}"><strong>${esc(r.title)}</strong><span>${esc(r.machine)} · ${esc(r.owner.username)} · ${esc(labels[r.state]||r.state)}</span><small>${esc(r.id)}</small></button>`).join('')||'<p class="empty">暂无历史记录。</p>';
      for(const node of q('#maintenance-list').querySelectorAll('[data-id]'))node.addEventListener('click',()=>show(node.dataset.id));
    }catch(error){if(same(stamp))q('#maintenance-list-error').textContent=error.message;}
    finally{if(same(stamp))loading=false;}
  }
  async function show(id){
    const stamp=generation,sequence=++selectionSerial;
    try{
      const r=await store.call('maintenance.get',{id});if(!same(stamp)||sequence!==selectionSerial)return;
      q('#maintenance-detail').innerHTML=`<article class="maintenance-detail"><h3>${esc(r.title)}</h3><p>${esc(r.machine)} · ${esc(r.owner.username)} · ${esc(labels[r.state]||r.state)}</p>
        <p class="muted">${esc(r.id)}</p><p>原申请原因：${esc(r.reason)}</p><p>目录：${esc(r.cwd)} · 超时 ${esc(r.timeoutSec)}s</p><p class="maintenance-hash">脚本 SHA256：${esc(r.scriptSha256)}</p><pre tabindex="0">${esc(r.script)}</pre>
        ${r.execution?`<p class="maintenance-hash">原执行键：${esc(r.execution.id)}</p>`:''}
        ${r.decision?`<p>处理人：${esc(r.decision.by.username)}${r.decision.reason?' · '+esc(r.decision.reason):''}</p>`:''}${r.error?`<p role="status">${esc(r.error)}</p>`:''}
        ${r.result?`<p>上次回执：${esc(labels[r.result.state]||r.result.state)} · 退出码 ${esc(r.result.exitCode??'未确认')} · ${esc(r.result.checkedAt)}</p><h4>标准输出</h4><pre tabindex="0">${esc(r.result.stdout)}</pre><h4>错误输出</h4><pre tabindex="0">${esc(r.result.stderr)}</pre>${r.result.truncated?.stdout||r.result.truncated?.stderr?'<p>输出已截断，每路最多 64 KiB。</p>':''}`:''}</article>`;
    }catch(error){if(same(stamp))q('#maintenance-list-error').textContent=error.message;}
  }
  return selected=>{
    const enabled=store.production===true&&store.data?.maintenance?.version===1&&!!store.principal;
    const nav=document.querySelector('[data-nav=maintenance]');if(nav)nav.hidden=true;
    if(identity!==store.principal?.userId){reset();identity=store.principal?.userId;}
    active=selected&&enabled;if(!active||!host)return;
    if(!ready)build();load();
  };
}
