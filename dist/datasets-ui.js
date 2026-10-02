import {scanBrowserDirectory,uploadBrowserDataset} from './dataset-upload.js';
import {dataWorkspaceHTML,dataWorkspaceUI} from './data-workspace.js';
import {transferUploadCall} from './transfer-upload.js';
import {cloudImportHTML,cloudImportUI} from './cloud-import-ui.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={READY:'本机已就绪',REGISTERED:'待准备',STAGING:'未完成，可续传',PREPARING:'准备中',FAILED:'准备失败',NOT_LOCAL:'本机没有此版本',UNKNOWN:'本机状态待确认'};
const bytesLabel=value=>{const bytes=Number(value);if(!Number.isFinite(bytes)||bytes<0)return '未知';return bytes<1024**3?(bytes/1024**2).toFixed(1)+' MiB':(bytes/1024**3).toFixed(2)+' GiB';};
export function capacityText(capacity){
  if(!capacity||capacity.available!==true||!Number.isFinite(capacity.availableBytes)||capacity.availableBytes<0||!Number.isFinite(capacity.filesystemBytes)||capacity.filesystemBytes<0)return '容量暂未确认；上传或发布前请刷新。';
  return `本机数据盘可用 ${bytesLabel(capacity.availableBytes)} / 共 ${bytesLabel(capacity.filesystemBytes)}${Number.isFinite(capacity.usableBytes)?` · 扣除预留后 ${bytesLabel(capacity.usableBytes)}`:''}${Number.isFinite(capacity.reserveBytes)?`（安全预留 ${bytesLabel(capacity.reserveBytes)}）`:''}。共享磁盘容量，不是个人配额。`;
}
export function datasetRows(catalog){
  return (catalog?.datasets||[]).flatMap(item=>(item.versions||[]).map(v=>{
    const state=v.state||'UNKNOWN',locations=Array.isArray(v.locations)?v.locations:[],remoteSource=v.canPrepare===true&&typeof v.sourceMachine==='string'&&v.sourceMachine.length>0,selectable=state==='READY'||state==='PREPARING'||v.canPrepare===true&&(['REGISTERED','STAGING'].includes(state)||state==='NOT_LOCAL'&&remoteSource);
    const where=locations.length?`<p class="dataset-locations">副本位置：${locations.map(location=>`${esc(location.machine)} · ${esc(location.state==='READY'?'已就绪':labels[location.state]||'待确认')}`).join('；')}</p>`:'';
    const help=v.canPrepare===false&&!['READY','PREPARING'].includes(state)?(state==='NOT_LOCAL'?'此版本没有到本机的可用共享通道；请选择已就绪机器，或在本机导入。':state==='UNKNOWN'?'本机状态尚未确认，请刷新后再操作。':String(item.dataset).startsWith('w-')?'回到个人数据空间，重新发布对应子目录。':'重新选择同一目录继续上传。'):v.sourceMachine?`将通过实验室内网从 ${esc(v.sourceMachine)} 准备固定版本，不占用 VPS 下载带宽。`:'';
    return `<article class="dataset-card"><div><div class="dataset-card-heading"><h3>${esc(item.name||item.dataset)}</h3><span data-state="${esc(state)}" class="dataset-readiness ${state==='READY'?'ready':''}">${esc(labels[state]||state)}</span></div><p class="muted">${esc(bytesLabel(v.bytes||0))} · ${Number(v.files||0)} 个文件</p>${where}${v.error?`<p class="form-error" role="status">${esc(v.error)}</p>`:''}<label class="field">固定版本<input readonly value="${esc(item.dataset+'@'+v.version)}" aria-label="${esc(item.dataset)} 的固定版本" spellcheck="false"></label><p class="muted">训练路径：<code>/data2/${esc(item.dataset)}</code>（只读）</p>${help?`<p class="muted">${help}</p>`:''}${selectable&&state!=='READY'?'<p class="muted">可先提交训练；数据在后台准备完成后才排 GPU，不会提前占卡。</p>':''}</div><div class="file-actions">${v.canPrepare===false?'':`<button class="button" data-prepare-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${['READY','PREPARING','UNKNOWN'].includes(state)?'disabled':''}>准备到本机</button>`}<button class="button primary" data-use-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${selectable?'':'disabled'}>${selectable&&state!=='READY'?'准备后训练':'用于训练'}</button></div></article>`;
  })).join('')||(catalog?.partial?'<div class="empty">目录尚未完整确认，暂无可确认版本。<br>请刷新或检查机器连接；不能据此认定没有数据。</div>':'<div class="empty">还没有分配或上传的数据集。<br>从“添加数据”导入自己的数据，或联系管理员分配。</div>');
}
export function datasetsUI(store,toast){
  const section=document.querySelector('#page-datasets');let identity='',generation=0,busy=false,uploadBusy=false,discardBusy=false,controller=null,active=null,machineIds='';
  const account=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
  const current=expected=>expected===account();
  const human=bytes=>(Number(bytes||0)/1024**3).toFixed(2)+' GiB';
  const workspace=dataWorkspaceUI(store,section,toast,{onBusyChange:controls,refreshCatalog:load});
  const cloud=cloudImportUI(store,section,toast);
  function source(next){
    if(!['directory','link','workspace'].includes(next))return;
    for(const button of section.querySelectorAll('[data-dataset-source]')){const selected=button.dataset.datasetSource===next;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}
    for(const panel of section.querySelectorAll('[data-dataset-panel]'))panel.hidden=panel.dataset.datasetPanel!==next;
  }
  function controls(){
    const enabled=store.production&&store.principal&&(store.data?.machines||[]).length,blocked=busy||uploadBusy||discardBusy||workspace.busy;
    for(const selector of ['#datasets-refresh','[name=dataset-machine]']){const node=section.querySelector(selector);if(node)node.disabled=!enabled||blocked;}
    for(const selector of ['#dataset-upload-start','[name=dataset-name]','[name=dataset-directory]']){const node=section.querySelector(selector);if(node)node.disabled=!enabled||uploadBusy||discardBusy||workspace.busy||active?.state==='DISCARDING';}
    for(const node of section.querySelectorAll('[data-dataset-source],#dataset-organize-next'))node.disabled=!enabled||uploadBusy||discardBusy||workspace.busy;
    const pause=section.querySelector('#dataset-upload-pause'),discard=section.querySelector('#dataset-upload-discard');if(pause)pause.hidden=!uploadBusy;if(discard)discard.hidden=uploadBusy||!active?.uploadId||['READY','DISCARDED'].includes(active.state);
    workspace.controls();
    cloud.controls();
  }
  store.onAuthChange?.(()=>{cloud.reset();workspace.reset();controller?.abort();controller=null;uploadBusy=false;discardBusy=false;active=null;busy=false;generation++;identity='';machineIds='';section.replaceChildren();});
  async function load(){
    if(busy||uploadBusy||discardBusy||!store.principal)return;
    const machine=section.querySelector('[name=dataset-machine]')?.value;if(!machine)return;
    busy=true;const token=++generation,expected=account(),button=section.querySelector('#datasets-refresh'),select=section.querySelector('[name=dataset-machine]');button.disabled=true;select.disabled=true;
    const valid=()=>token===generation&&current(expected)&&section.querySelector('[name=dataset-machine]')?.value===machine;
    const status=section.querySelector('#datasets-status'),capacity=section.querySelector('#datasets-capacity');status.textContent='正在汇总已授权机器的数据集…';capacity.textContent='正在读取本机容量…';section.querySelector('#dataset-catalog').replaceChildren();
    try{await Promise.all([
      store.call('datasets.catalog',{machine}).then(result=>{if(!valid())return;section.querySelector('#dataset-catalog').innerHTML=datasetRows(result);status.textContent=result.partial?'部分机器目录未确认；已显示可确认的版本。当前服务器就绪或有批准来源的版本可选入训练。':'目录已更新。就绪后训练；有批准来源的版本可先提交、后台准备，不占 GPU。位置不代表自动跨机复制。';}).catch(error=>{if(valid()){section.querySelector('#dataset-catalog').replaceChildren();status.textContent='目录未能确认：'+error.message;}}),
      store.call('datasets.capacity',{machine}).then(result=>{if(valid())capacity.textContent=capacityText(result);}).catch(()=>{if(valid())capacity.textContent=capacityText(null);})
    ]);}
    finally{if(token===generation){busy=false;controls();}}
  }
  section.addEventListener('change',e=>{if(e.target.name==='dataset-machine'){workspace.reset();document.dispatchEvent(new CustomEvent('gpuq-data-workspace-context'));active=null;section.querySelector('#data-workspace-files-list').replaceChildren();section.querySelector('#data-workspace-status').textContent='已切换服务器；目录与数据终端不会跨机同步。';section.querySelector('#dataset-upload-status').textContent='上传到当前所选服务器；不同机器不会自动同步。';controls();load();}if(e.target.name==='dataset-directory'){const files=Array.from(e.target.files||[]),status=section.querySelector('#dataset-upload-status');status.textContent=files.length?`已选择 ${files.length} 个文件 · ${human(files.reduce((n,f)=>n+f.size,0))}。`:'请选择目录。';}});
  section.addEventListener('submit',async e=>{
    if(e.target.id!=='dataset-upload-form')return;e.preventDefault();if(uploadBusy||discardBusy||workspace.busy||!store.production||!store.principal)return;
    const form=e.target,machine=section.querySelector('[name=dataset-machine]').value,name=form.elements['dataset-name'].value.trim(),files=form.elements['dataset-directory'].files,expected=account(),userId=store.principal.userId;
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name)){toast('名称需为 1–40 位字母、数字、下划线或连字符。');return;}
    if(!files?.length){toast('请先选择包含文件的目录。');return;}
    controller=new AbortController();const signal=controller.signal;uploadBusy=true;active=null;controls();
    const status=section.querySelector('#dataset-upload-status'),progress=section.querySelector('#dataset-upload-progress');progress.hidden=false;progress.removeAttribute('value');
    const check=()=>{if(!current(expected)||signal.aborted)throw Error('上传已暂停；选择同一目录可继续。');};
    const report=value=>{check();if(value.uploadId)active={...value,machine};const labels={HASHING:'计算文件校验值',RECEIVING_MANIFEST:'上传目录清单',SEALING:'校验目录清单',UPLOADING:'上传文件',PUBLISHING:'服务器完整校验',READY:'本机已就绪'};status.textContent=`${machine} · ${labels[value.state]||value.state}${value.path?' · '+value.path:''}${value.bytes!==undefined?' · '+human(value.bytes)+' / '+human(value.totalBytes):''}`;if(value.bytes!==undefined&&value.totalBytes>0){progress.max=value.totalBytes;progress.value=value.bytes;}else progress.removeAttribute('value');};
    try{
      status.textContent=machine+' · 正在读取目录…';
      const scan=await scanBrowserDirectory(files,{signal,onProgress:report});check();
      const keyStore={get:key=>{try{return localStorage.getItem('gpuq.dataset-upload.'+key);}catch{return null;}},set:(key,value)=>{try{localStorage.setItem('gpuq.dataset-upload.'+key,value);}catch{throw Error('浏览器无法保存续传标识，请允许本站本地存储或使用 CLI。');}}};
      const directCall=async(operation,args)=>{check();const result=await store.call(operation,args);check();return result;};
      const call=store.data?.transfers?.version===1?transferUploadCall(directCall,row=>{status.textContent='传输 '+row.id+' · '+row.state;}):directCall;
      const result=await uploadBrowserDataset({userId,machine,name,scan,signal,onProgress:report,keyStore,call});check();
      active={...result,machine};status.textContent=`${machine} · 本机已就绪 · ${result.dataset}@${result.version}`;progress.value=progress.max=1;toast('数据集上传并校验完成，可以用于训练。');
    }catch(error){if(current(expected)){status.textContent=error.message+(active?.uploadId?' 重新点击“上传 / 继续”可检查并续传。':'');}}
    finally{if(current(expected)){uploadBusy=false;controller=null;controls();if(active?.state==='READY')await load();}}
  });
  section.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.dataset.datasetSource){source(b.dataset.datasetSource);return;}
    if(b.id==='dataset-organize-next'){source('workspace');section.querySelector('#dataset-source-workspace').focus();return;}
    if(b.id==='datasets-refresh'){load();return;}
    if(b.id==='dataset-upload-pause'){controller?.abort();return;}
    if(b.id==='dataset-upload-discard'){
      if(!active?.uploadId||uploadBusy||discardBusy)return;const expected=account(),target={...active};discardBusy=true;b.disabled=true;controls();
      try{let result=await store.call('datasets.upload.discard',{machine:target.machine,uploadId:target.uploadId});if(!current(expected))return;active={...result,machine:target.machine};controls();while(result.state==='DISCARDING'){section.querySelector('#dataset-upload-status').textContent='正在取消未完成上传…';await new Promise(resolve=>setTimeout(resolve,1500));if(!current(expected))return;result=await store.call('datasets.upload.status',{machine:target.machine,uploadId:target.uploadId});if(!current(expected))return;active={...result,machine:target.machine};}section.querySelector('#dataset-upload-status').textContent=result.state==='DISCARDED'?'未完成上传已取消。':result.error||'取消结果尚未确认，请重新检查。';}
      catch(error){if(current(expected))toast(error.message);}finally{if(current(expected)){discardBusy=false;b.disabled=false;controls();}}return;
    }
    const machine=section.querySelector('[name=dataset-machine]').value;
    if(b.dataset.prepareDataset){const expected=account(),token=generation;b.disabled=true;try{const result=await store.call('datasets.prepare',{machine,dataset:b.dataset.prepareDataset,version:b.dataset.version});if(!current(expected)||token!==generation)return;toast(result.state==='READY'?'数据已经就绪。':'已开始后台准备。完成前不占 GPU，可稍后刷新查看。');await load();}catch(error){if(current(expected)&&token===generation){toast(error.message);b.disabled=false;}}}
    if(b.dataset.useDataset){
      document.querySelector('[data-nav=work]').click();
      const form=document.querySelector('#train-form');if(!form)return;
      form.elements.machine.value=machine;form.elements.datasets.value=b.dataset.useDataset+'@'+b.dataset.version;
      form.elements.datasets.dispatchEvent(new Event('input',{bubbles:true}));form.closest('details').open=true;form.elements.command.focus();
    }
  });
  section.addEventListener('keydown',event=>{
    const button=event.target.closest('[data-dataset-source]');if(!button||button.disabled)return;
    const buttons=[...section.querySelectorAll('[data-dataset-source]')],index=buttons.indexOf(button);let next;
    if(event.key==='ArrowRight')next=(index+1)%buttons.length;if(event.key==='ArrowLeft')next=(index+buttons.length-1)%buttons.length;if(event.key==='Home')next=0;if(event.key==='End')next=buttons.length-1;
    if(next!==undefined&&!buttons[next].disabled){event.preventDefault();source(buttons[next].dataset.datasetSource);buttons[next].focus();}
  });
  return ()=>{
    const machines=store.data?.machines||[];
    const next=account(),ids=JSON.stringify(machines.map(m=>m.id));
    if(next!==identity){workspace.reset();controller?.abort();controller=null;uploadBusy=false;discardBusy=false;active=null;identity=next;generation++;busy=false;machineIds='';
      section.classList.add('datasets-unified');
      section.innerHTML=`<p class="muted datasets-intro">一个目录查看数据和可用位置。选择本次使用的服务器，已就绪版本可直接填入训练。</p>
        <div class="terminal-controls datasets-controls"><label>本次使用的服务器<select name="dataset-machine"></select></label><button class="button" id="datasets-refresh">加载 / 刷新</button></div>
        <p id="datasets-capacity" class="datasets-capacity" role="status">加载后显示本机数据盘容量；不代表个人硬配额。</p>
        <section aria-labelledby="dataset-catalog-heading"><div class="datasets-library-heading"><h3 id="dataset-catalog-heading">我的数据集</h3><span class="muted">固定版本 · 本机就绪后训练</span></div><p id="datasets-status" role="status">${!store.principal?'请先登录。':!machines.length?'当前没有已授权机器。':'选择服务器，再加载数据集。'}</p><div id="dataset-catalog" class="dataset-catalog"></div></section>
        <details id="datasets-add" class="datasets-add"><summary>添加数据 <span>选择来源，整理后发布</span></summary>
        <ol class="datasets-flow"><li>选择来源</li><li>按需手动整理</li><li>校验发布并用于训练</li></ol>
        <div class="dataset-source-tabs" role="tablist" aria-label="添加数据的方式">
          <button type="button" role="tab" id="dataset-source-directory" data-dataset-source="directory" aria-controls="dataset-panel-directory" aria-selected="true">已整理的本机目录</button>
          <button type="button" role="tab" id="dataset-source-link" data-dataset-source="link" aria-controls="dataset-panel-link" aria-selected="false" tabindex="-1">链接 / 云盘导入</button>
          <button type="button" role="tab" id="dataset-source-workspace" data-dataset-source="workspace" aria-controls="dataset-panel-workspace" aria-selected="false" tabindex="-1">文件与手动整理</button>
        </div>
        <div id="dataset-panel-directory" data-dataset-panel="directory" role="tabpanel" aria-labelledby="dataset-source-directory">
        <form id="dataset-upload-form" aria-labelledby="dataset-upload-heading">
          <div class="dataset-upload-heading"><h3 id="dataset-upload-heading">上传并发布整理好的目录</h3><p class="muted">已在电脑上整理好？选择目录后直接上传、校验并发布，不需要终端步骤。压缩包不会自动解压。</p></div>
          <div class="dataset-upload-fields">
            <label class="field">数据集名称<input name="dataset-name" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,39}" placeholder="my-data" aria-describedby="dataset-name-help" required><small id="dataset-name-help">1–40 位字母、数字、下划线或连字符。</small></label>
            <label class="field">本机目录<input type="file" name="dataset-directory" webkitdirectory multiple aria-describedby="dataset-directory-help"><small id="dataset-directory-help">选择整个目录；网页上传不包含空目录。</small></label>
          </div>
          <div class="file-actions dataset-upload-actions"><button class="button primary" type="submit" id="dataset-upload-start">上传 / 继续</button><button class="button" type="button" id="dataset-upload-pause" hidden>暂停传输</button><button class="button" type="button" id="dataset-upload-discard" hidden>取消未完成上传</button></div>
          <div class="dataset-upload-feedback"><progress id="dataset-upload-progress" aria-label="数据集上传进度" hidden></progress><p id="dataset-upload-status" role="status">选择目录后开始；同一目录可断点续传。</p></div>
          <div class="dataset-upload-notes"><p class="muted">关闭页面会停止传输，已开始的服务器校验会继续。</p><p class="muted">大目录建议使用 <code>gpuctl data upload</code>。</p></div>
        </form></div>
        <div id="dataset-panel-link" data-dataset-panel="link" role="tabpanel" aria-labelledby="dataset-source-link" hidden>${cloudImportHTML(store.principal?.role==='admin')}<p class="datasets-next">下载完成只代表文件已到个人空间，尚未发布训练版本。</p><button class="button" type="button" id="dataset-organize-next">下一步：手动整理与发布</button></div>
        <div id="dataset-panel-workspace" data-dataset-panel="workspace" role="tabpanel" aria-labelledby="dataset-source-workspace" hidden>${dataWorkspaceHTML()}</div></details>`;
    }
    if(ids!==machineIds){
      const select=section.querySelector('[name=dataset-machine]'),selected=select.value,changed=machineIds!=='';
      select.innerHTML=machines.map(m=>`<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('');
      if(machines.some(m=>m.id===selected))select.value=selected;
      else if(selected){workspace.reset();cloud.reset(false);document.dispatchEvent(new CustomEvent('gpuq-data-workspace-context'));controller?.abort();active=null;section.querySelector('#data-workspace-files-list').replaceChildren();section.querySelector('#cloud-import-list').replaceChildren();section.querySelector('#data-workspace-status').textContent='服务器授权已改变；请重新确认当前机器。';section.querySelector('#cloud-import-status').textContent='服务器授权已改变；请刷新当前机器的导入进度。';}
      // The catalog spans all authorized machines: even removal of a different
      // machine must invalidate old rows and any in-flight aggregate response.
      if(changed){generation++;busy=false;section.querySelector('#dataset-catalog').replaceChildren();section.querySelector('#datasets-capacity').textContent=capacityText(null);section.querySelector('#datasets-status').textContent=machines.length?'机器授权已更新，请重新加载目录。':'当前没有已授权机器。';}
      machineIds=ids;
    }
    controls();
  };
}
