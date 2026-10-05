import {maintenanceFor,restoreMaintenanceControls,disableMaintenanceControls} from './maintenance-state.js';
import {copyHelp} from './copy-help-ui.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size=n=>!Number.isFinite(n)||n<0?'未知':n<1024?Math.round(n)+' B':n<1024**2?(n/1024).toFixed(1)+' KiB':n<1024**3?(n/1024**2).toFixed(1)+' MiB':(n/1024**3).toFixed(2)+' GiB';
const labels={QUEUED:'准备中',RUNNING:'下载中',CANCELING:'正在取消',PAUSED:'已暂停',READY:'已下载',FAILED:'失败',CANCELED:'已取消',UNKNOWN:'待核对'};
export const shareCapability=info=>info?.capabilityVerified===true&&info.disabled!==true&&info.configurationEnabled!==false;
export function checkedImportURL(value){
  let parsed;try{parsed=new URL(value);}catch{throw Error('请输入完整 HTTPS 下载链接。');}
  if(typeof value!=='string'||value.length>16384||/[\x00-\x20\x7f]/.test(value)||parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash||(parsed.port&&parsed.port!=='443'))throw Error('请使用不含账号密码、片段或非 HTTPS 端口的 HTTPS 下载链接。');
  return parsed.href;
}
export function importRows(rows=[]){return rows.map(r=>{
  const stopped=['PAUSED','FAILED','CANCELED','READY'].includes(r.state);
  const hint=r.state==='READY'?copyHelp('已下载','已保存到个人 /data2，可打开数据终端解压。整理后再发布为训练数据集。'):r.state==='CANCELING'?copyHelp('正在取消','等待下载进程停止；临时文件仍保留，请稍后刷新确认。'):r.state==='CANCELED'?copyHelp('已取消','临时文件仍占用空间；可继续同一任务，取消不会删除已下载内容。'):'';
  return `<li><div><strong>${esc(r.path)}</strong><p>${esc(labels[r.state]||'状态未确认')}${hint} · ${size(r.bytes)}${r.totalBytes!==undefined?' / '+size(r.totalBytes):''}</p>
    ${r.error?`<p class="form-error">${esc(r.error)}</p>`:''}
    ${stopped&&r.canResume&&r.sourceKind==='https'?`<details data-import-replace-panel="${esc(r.operationId)}"><summary>链接过期？换链接继续</summary><form data-import-replace="${esc(r.operationId)}"><label class="field">同一文件的新 HTTPS 链接<input name="cloud-resume-url" type="url" maxlength="16384" autocomplete="off" spellcheck="false" placeholder="https://…" required></label><p class="muted">只更新下载地址；原保存位置和校验要求不变。</p><button class="button" type="submit">换链接并继续</button></form></details>`:''}
    </div><div class="file-actions">
    ${stopped&&r.canResume?`<button class="button" type="button" data-import-resume="${esc(r.operationId)}">继续</button>`:''}
    ${['QUEUED','RUNNING','PAUSED','FAILED'].includes(r.state)?`<button class="button" type="button" data-import-cancel="${esc(r.operationId)}">取消</button>`:''}
    ${stopped?`<button class="button" type="button" data-import-discard="${esc(r.operationId)}">清理记录</button>`:''}
    </div></li>`;
}).join('')||'<li class="muted">暂无导入任务。</li>';}
export function cloudImportHTML(admin=false){return `<section class="data-workspace-card cloud-import" aria-labelledby="cloud-import-title">
  <header><div><p class="data-workspace-eyebrow">大文件推荐</p><h3 id="cloud-import-title">从链接导入</h3></div><span class="data-workspace-badge">服务器直下</span></header>
  <form id="cloud-import-form"><div class="data-workspace-fields"><label class="field"><span>来源${copyHelp('链接导入','文件保存到所选服务器的个人数据空间；关闭网页后继续，不会自动解压。阿里分享需后台确认开放，已连接云盘不代表可用。')}</span><select name="cloud-source"><option value="https">HTTPS 下载链接</option><option value="aliyun">阿里云盘分享</option></select></label><label class="field">链接<input name="cloud-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://…" required></label></div>
  <div id="cloud-share-availability" hidden><span>阿里云盘分享暂不可用</span><button class="button" id="cloud-share-refresh" type="button">重新查询</button></div>
  <div id="cloud-share-fields" class="data-workspace-fields"><label class="field">提取码（可选）<input name="cloud-password" autocomplete="off" maxlength="16"></label><div class="field"><span>分享文件</span><button class="button" id="cloud-inspect" type="button">读取文件</button><select name="cloud-file" aria-label="选择分享文件"><option value="">先读取分享文件</option></select></div></div>
  <label class="field"><span>保存为${copyHelp('保存位置','填写个人数据空间内的相对文件路径。不会覆盖已有文件。')}</span><input name="cloud-path" placeholder="incoming/dataset.zip" required></label>
  <details id="cloud-checksum-fields" hidden><summary>文件校验（可选）</summary><label class="field">SHA-256<input name="cloud-sha256" pattern="[a-f0-9]{64}" spellcheck="false" disabled></label></details>
  <div class="file-actions"><button class="button primary" type="submit">开始导入</button><button class="button" id="cloud-import-refresh" type="button">刷新进度</button></div></form>
  <aside id="cloud-import-pending" hidden><p>导入结果未确认。</p><details><summary>操作编号</summary><code id="cloud-import-pending-key"></code></details><button class="button" id="cloud-import-retry" type="button">用同一请求重试</button></aside>
  <p id="cloud-import-status" role="status">填写 HTTPS 下载链接。</p><ul id="cloud-import-list" class="cloud-import-list"></ul>
  ${admin?`<details id="cloud-admin"><summary>云盘连接 · 仅管理员${copyHelp('云盘连接','后台账号只用于处理已批准的来源，成员不能浏览账号或取得令牌。扫码授权可能允许访问整个云盘，请仅连接你有权使用的账号。')}</summary><div class="file-actions"><button class="button" id="cloud-auth-begin" type="button">连接 / 重新授权</button><button class="button" id="cloud-auth-disconnect" type="button">断开授权</button></div><img id="cloud-auth-qr" alt="用阿里云盘 App 扫码授权" width="240" height="240" hidden><button class="button" id="cloud-auth-check" type="button" hidden>我已确认，检查状态</button><p id="cloud-auth-status" role="status"></p></details>`:''}
  </section>`;}
export function cloudImportUI(store,section,toast){
  let epoch=0,inspection=null,auth=null,busy=false,timer=null;
  // Pending URLs and share inspections live only in this page's memory. Keep
  // the original request through uncertain replies and machine switches.
  const pending=new Map(),capabilities=new Map();
  const $=s=>section.querySelector(s),machine=()=>$('[name=dataset-machine]')?.value;
  const scope=()=>JSON.stringify([store.principal?.userId,store.authGeneration,machine()]);
  const context=()=>JSON.stringify([store.principal?.userId,store.authGeneration,machine(),epoch]);
  const report=t=>{const el=$('#cloud-import-status');if(el)el.textContent=t;};
  function controls(){
    const card=$('.cloud-import');if(!card)return;restoreMaintenanceControls(card);
    const owner=store.data?.users?.find(row=>row.id===store.principal?.userId);
    const disabled=busy||!store.production||!store.principal||!machine()||owner&&(owner.enabled===false||!(owner.limits?.[machine()]>0)),held=pending.get(scope()),aliyun=$('[name=cloud-source]')?.value==='aliyun',info=capabilities.get(scope()),unavailable=!shareCapability(info);
    for(const el of card.querySelectorAll('input,button:not([data-copy-help]),select'))el.disabled=disabled||!!held&&el.closest('#cloud-import-form')&&el.id!=='cloud-import-refresh';
    $('#cloud-share-availability').hidden=!aliyun||!unavailable;
    if(aliyun&&unavailable)for(const el of card.querySelectorAll('#cloud-inspect,[name=cloud-file],#cloud-import-form [type=submit]'))el.disabled=true;
    const connect=$('#cloud-auth-begin');if(connect)connect.hidden=info?.managedExternally===true;
    $('#cloud-share-fields').hidden=!aliyun||unavailable;$('#cloud-checksum-fields').hidden=aliyun;
    $('[name=cloud-sha256]').disabled=disabled||!!held||aliyun;
    disableMaintenanceControls(card,'#cloud-import-form [type=submit],#cloud-inspect,#cloud-import-retry,#cloud-auth-begin,#cloud-auth-check,#cloud-auth-disconnect,[data-import-resume],[data-import-discard],[data-import-replace] [type=submit]',maintenanceFor(store.data?.operationalMaintenance,machine()));
    $('#cloud-import-pending').hidden=!held;$('#cloud-import-pending-key').textContent=held?.args.key||'';
  }
  function reset(forgetPending=true){epoch++;clearTimeout(timer);timer=null;inspection=null;auth=null;busy=false;if(forgetPending){pending.clear();capabilities.clear();}}
  async function run(fn){if(busy||!store.production||!store.principal||!machine())return;const owner=store.data?.users?.find(row=>row.id===store.principal.userId);if(owner&&(owner.enabled===false||!(owner.limits?.[machine()]>0))){report('这台服务器未授权。');return;}busy=true;controls();const expected=context();const check=()=>{if(expected!==context())throw Error('账号或服务器已改变。');};const call=async(op,args={})=>{check();const result=await store.call(op,args);check();return result;};try{await fn(call,check);}catch(e){if(expected===context()){report(e.message);toast(e.message);}}finally{if(expected===context()){busy=false;controls();}}}
  async function shareInfo(call){
    const key=scope();capabilities.delete(key);controls();
    const result=await call('cloud.info',{});capabilities.set(key,result);
    const status=$('#cloud-auth-status');
    if(status)status.textContent=result?.managedExternally===true?'云盘连接由后台管理。':result?.aliyunConnected===true?(shareCapability(result)?'已登录，分享导入已核验。':'已登录，但分享导入未核验。'):'云盘登录未确认。';
    if($('[name=cloud-source]').value==='aliyun')report('');controls();return result;
  }
  async function list(call){
    const result=await call('cloud.import.list',{machine:machine()}),rows=result?.imports,held=pending.get(scope());
    if(!Array.isArray(rows))throw Error('导入列表未确认，请重新查询。');
    if(held&&rows.some(r=>r.operationId===held.args.key&&Object.hasOwn(labels,r.state)&&r.state!=='UNKNOWN')){pending.delete(scope());report('已找到原导入任务，没有重复创建。');}
    const drafts=new Map([...section.querySelectorAll('[data-import-replace-panel]')].map(el=>[el.dataset.importReplacePanel,{open:el.open,value:el.querySelector('input').value}]));
    $('#cloud-import-list').innerHTML=importRows(rows);
    for(const el of section.querySelectorAll('[data-import-replace-panel]')){const draft=drafts.get(el.dataset.importReplacePanel);if(draft){el.open=draft.open;el.querySelector('input').value=draft.value;}}
    clearTimeout(timer);
    if(rows.some(r=>['QUEUED','RUNNING','CANCELING'].includes(r.state)))timer=setTimeout(()=>{if(!document.hidden&&!section.hidden)run(list);},8000);
  }
  async function start(call,held){
    const key=scope();
    pending.set(key,held);controls();
    try{const result=await call('cloud.import.start',held.args);if(result?.operationId!==held.args.key||!Object.hasOwn(labels,result.state)||result.state==='UNKNOWN')throw Error('导入回执未确认。');if(pending.get(key)===held)pending.delete(key);report(labels[result.state]);await list(call);}
    catch(error){
      if(pending.get(key)===held){
        held.uncertain=true;try{const result=await call('cloud.import.status',{machine:machine(),operationId:held.args.key});if(result.operationId===held.args.key&&Object.hasOwn(labels,result.state)&&result.state!=='UNKNOWN'){pending.delete(key);report(labels[result.state]);await list(call);return;}}catch{ /* Only query the original ID; no automatic start replay. */ }
      }
      throw error;
    }
  }
  section.addEventListener('change',event=>{
    if(['cloud-url','cloud-password','cloud-source'].includes(event.target.name)){inspection=null;const files=$('[name=cloud-file]');if(files)files.innerHTML='<option value="">先读取分享文件</option>';}
    if(event.target.name==='cloud-file'){const file=inspection?.files.find(f=>f.id===event.target.value);if(file)$('[name=cloud-path]').value='incoming/'+file.name;}
    if(event.target.name==='dataset-machine'){reset(false);$('#cloud-import-list')?.replaceChildren();$('#cloud-auth-status')?.replaceChildren();$('#cloud-auth-qr')?.setAttribute('hidden','');$('#cloud-auth-check')?.setAttribute('hidden','');report('已切换服务器。点击刷新查看导入任务。');}
    if((event.target.name==='cloud-source'||event.target.name==='dataset-machine')&&$('[name=cloud-source]')?.value==='aliyun'&&!capabilities.has(scope()))run(shareInfo);
    controls();
  });
  section.addEventListener('toggle',event=>{if(event.target.id==='cloud-admin'&&event.target.open&&!capabilities.has(scope()))run(shareInfo);},true);
  section.addEventListener('submit',event=>{
    if(event.target.dataset.importReplace){event.preventDefault();return run(async call=>{const args={machine:machine(),operationId:event.target.dataset.importReplace,url:checkedImportURL(event.target.elements['cloud-resume-url'].value.trim())};await call('cloud.import.resume',args);report('已请求用新链接继续同一任务；保存位置和校验要求不变。');await list(call);});}
    if(event.target.id!=='cloud-import-form')return;event.preventDefault();run(async call=>{
      if(pending.has(scope()))throw Error('请先核对未确认的导入；重试必须沿用原标识。');
      const args={machine:machine(),key:crypto.randomUUID(),path:$('[name=cloud-path]').value.trim()};
      if($('[name=cloud-source]').value==='aliyun'){if(!shareCapability(capabilities.get(scope())))throw Error('阿里云盘分享暂不可用。');if(!inspection)throw Error('请先读取分享文件。');args.inspectionId=inspection.inspectionId;args.fileId=$('[name=cloud-file]').value;if(!args.fileId)throw Error('请选择分享文件。');}
      else{args.url=checkedImportURL($('[name=cloud-url]').value.trim());const hash=$('[name=cloud-sha256]').value.trim();if(hash)args.sha256=hash;}
      await start(call,{args:Object.freeze(args),uncertain:false});
    });
  });
  section.addEventListener('click',event=>{const b=event.target.closest('button');if(!b||b.disabled)return;
    if(b.id==='cloud-inspect')return run(async call=>{if(!shareCapability(capabilities.get(scope())))throw Error('阿里云盘分享暂不可用。');inspection=await call('cloud.inspect',{machine:machine(),url:$('[name=cloud-url]').value.trim(),password:$('[name=cloud-password]').value.trim()});$('[name=cloud-file]').innerHTML=inspection.files.map(f=>`<option value="${esc(f.id)}">${esc(f.name)} · ${size(f.size)}</option>`).join('');if(inspection.files[0])$('[name=cloud-path]').value='incoming/'+inspection.files[0].name;report(inspection.files.length?'选择文件，然后开始导入。':'没有可导入的文件。请将数据压缩后，直接分享压缩包。');});
    if(b.id==='cloud-share-refresh')return run(shareInfo);
    if(b.id==='cloud-import-refresh')return run(async call=>{if($('[name=cloud-source]').value==='aliyun'){try{await shareInfo(call);}catch(error){report(error.message);toast(error.message);}}await list(call);});
    if(b.id==='cloud-import-retry')return run(async call=>{const held=pending.get(scope());if(!held)return;try{const result=await call('cloud.import.status',{machine:machine(),operationId:held.args.key});if(result.operationId!==held.args.key)throw Error('原导入编号未确认。');if(result.state==='UNKNOWN'||!Object.hasOwn(labels,result.state))throw Error('导入结果未确认，请重新查询。');pending.delete(scope());await list(call);return;}catch(error){if(error.status!==404)throw error;}if(held.args.inspectionId&&!shareCapability(await shareInfo(call)))throw Error('阿里云盘分享暂不可用。');await start(call,held);});
    if(b.dataset.importResume)return run(async call=>{await call('cloud.import.resume',{machine:machine(),operationId:b.dataset.importResume});report('已请求继续；后台会先核验文件身份。');await list(call);});
    if(b.dataset.importCancel)return run(async call=>{if(!confirm('取消此导入？已下载的临时文件会保留并继续占用空间，可稍后继续同一任务；取消不会删除文件。'))return;const result=await call('cloud.import.cancel',{machine:machine(),operationId:b.dataset.importCancel});report(result.state==='CANCELING'?'正在取消，临时文件仍保留；请等待状态变为“已取消”。':'已请求取消；临时文件仍保留，请刷新确认状态。');await list(call);});
    if(b.dataset.importDiscard)return run(async call=>{const args={machine:machine(),operationId:b.dataset.importDiscard},status=await call('cloud.import.status',args);if(status.canDiscard!==true)throw Error('下载进程尚未确认停止，暂不能清理；请稍后刷新。');if(!confirm('清理这条导入记录及未完成的临时文件？清理后不能续传；已经完成并保存到个人 /data2 的文件不会删除。'))return;await call('cloud.import.discard',args);report('已清理导入记录和临时文件；已完成的数据文件保留。');await list(call);});
    if(b.id==='cloud-auth-begin')return run(async call=>{const info=await shareInfo(call);if(info?.managedExternally===true)throw Error('云盘连接由后台管理。');auth=await call('cloud.auth.begin');$('#cloud-auth-qr').src=auth.image;$('#cloud-auth-qr').hidden=false;$('#cloud-auth-check').hidden=false;$('#cloud-auth-status').textContent='用阿里云盘 App 扫码并确认，然后点击检查状态。';});
    if(b.id==='cloud-auth-check')return run(async call=>{if(!auth)throw Error('请重新获取二维码。');const result=await call('cloud.auth.poll',{id:auth.id});$('#cloud-auth-status').textContent=({NEW:'请先扫码。',SCANED:'请在阿里云盘 App 内确认。',CONFIRMED:'已登录，但分享导入未核验。',EXPIRED:'二维码已过期，请重新连接。',CANCELED:'已取消授权。'})[result.state]||'待确认';if(['CONFIRMED','EXPIRED','CANCELED'].includes(result.state)){$('#cloud-auth-qr').hidden=true;$('#cloud-auth-check').hidden=true;auth=null;}if(result.state==='CONFIRMED')await shareInfo(call);});
    if(b.id==='cloud-auth-disconnect')return run(async call=>{if(!confirm('断开后无法解析新的分享直链。已经发出的短期下载链接可能仍然有效；如需停止传输，请另外取消导入任务。'))return;const result=await call('cloud.auth.disconnect');capabilities.delete(scope());if(result?.disconnected!==true)throw Error('断开结果未确认，请重新查询。');$('#cloud-auth-status').textContent='已断开。';$('#cloud-auth-qr').hidden=true;$('#cloud-auth-check').hidden=true;auth=null;});
  });
  return {reset,controls};
}
