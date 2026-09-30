import {scanBrowserDirectory,uploadBrowserDataset} from './dataset-upload.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={READY:'本机已就绪',REGISTERED:'待准备',STAGING:'未完成，可续传',PREPARING:'准备中',FAILED:'准备失败'};
export function datasetRows(catalog){
  return (catalog?.datasets||[]).flatMap(item=>(item.versions||[]).map(v=>`<article class="dataset-card"><div><h3>${esc(item.name||item.dataset)}</h3><p class="muted">${esc(labels[v.state]||v.state)} · ${(Number(v.bytes||0)/1024**3).toFixed(2)} GiB · ${Number(v.files||0)} 个文件</p>${v.error?`<p class="form-error" role="status">${esc(v.error)}</p>`:''}<label class="field">固定版本<input readonly value="${esc(item.dataset+'@'+v.version)}" aria-label="${esc(item.dataset)} 的固定版本" spellcheck="false"></label><p class="muted">训练路径：<code>/data2/${esc(item.dataset)}</code>（只读）</p>${v.canPrepare===false&&v.state!=='READY'?'<p class="muted">重新选择同一目录继续上传。</p>':''}</div><div class="file-actions">${v.canPrepare===false?'':`<button class="button" data-prepare-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${['READY','PREPARING'].includes(v.state)?'disabled':''}>准备到本机</button>`}<button class="button primary" data-use-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${v.state==='READY'?'':'disabled'}>用于训练</button></div></article>`)).join('')||'<div class="empty">此机器还没有分配或上传的数据集。<br>可上传自己的目录，也可使用管理员分配的数据。</div>';
}
export function datasetsUI(store,toast){
  const section=document.querySelector('#page-datasets');let identity='',generation=0,busy=false,uploadBusy=false,discardBusy=false,controller=null,active=null,machineIds='';
  const account=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
  const current=expected=>expected===account();
  const human=bytes=>(Number(bytes||0)/1024**3).toFixed(2)+' GiB';
  function controls(){
    const enabled=store.production&&store.principal&&(store.data?.machines||[]).length,blocked=busy||uploadBusy||discardBusy;
    for(const selector of ['#datasets-refresh','[name=dataset-machine]']){const node=section.querySelector(selector);if(node)node.disabled=!enabled||blocked;}
    for(const selector of ['#dataset-upload-start','[name=dataset-name]','[name=dataset-directory]']){const node=section.querySelector(selector);if(node)node.disabled=!enabled||uploadBusy||discardBusy||active?.state==='DISCARDING';}
    const pause=section.querySelector('#dataset-upload-pause'),discard=section.querySelector('#dataset-upload-discard');if(pause)pause.hidden=!uploadBusy;if(discard)discard.hidden=uploadBusy||!active?.uploadId||['READY','DISCARDED'].includes(active.state);
  }
  store.onAuthChange?.(()=>{controller?.abort();controller=null;uploadBusy=false;discardBusy=false;active=null;busy=false;generation++;identity='';machineIds='';section.replaceChildren();});
  async function load(){
    if(busy||uploadBusy||discardBusy||!store.principal)return;
    const machine=section.querySelector('[name=dataset-machine]')?.value;if(!machine)return;
    busy=true;const token=++generation,button=section.querySelector('#datasets-refresh'),select=section.querySelector('[name=dataset-machine]');button.disabled=true;select.disabled=true;
    const status=section.querySelector('#datasets-status');status.textContent='正在读取数据集状态…';section.querySelector('#dataset-catalog').replaceChildren();
    try{const result=await store.call('datasets.list',{machine});if(token!==generation)return;section.querySelector('#dataset-catalog').innerHTML=datasetRows(result);status.textContent='已更新。准备数据不占用 GPU。';}
    catch(e){if(token===generation){section.querySelector('#dataset-catalog').replaceChildren();status.textContent=e.message;}}
    finally{if(token===generation){busy=false;controls();}}
  }
  section.addEventListener('change',e=>{if(e.target.name==='dataset-machine'){active=null;section.querySelector('#dataset-upload-status').textContent='上传到当前所选服务器；不同机器不会自动同步。';controls();load();}if(e.target.name==='dataset-directory'){const files=Array.from(e.target.files||[]),status=section.querySelector('#dataset-upload-status');status.textContent=files.length?`已选择 ${files.length} 个文件 · ${human(files.reduce((n,f)=>n+f.size,0))}。`:'请选择目录。';}});
  section.addEventListener('submit',async e=>{
    if(e.target.id!=='dataset-upload-form')return;e.preventDefault();if(uploadBusy||discardBusy||!store.production||!store.principal)return;
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
      const result=await uploadBrowserDataset({userId,machine,name,scan,signal,onProgress:report,keyStore,call:async(operation,args)=>{check();const result=await store.call(operation,args);check();return result;}});check();
      active={...result,machine};status.textContent=`${machine} · 本机已就绪 · ${result.dataset}@${result.version}`;progress.value=progress.max=1;toast('数据集上传并校验完成，可以用于训练。');
    }catch(error){if(current(expected)){status.textContent=error.message+(active?.uploadId?' 重新点击“上传 / 继续”可检查并续传。':'');}}
    finally{if(current(expected)){uploadBusy=false;controller=null;controls();if(active?.state==='READY')await load();}}
  });
  section.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.id==='datasets-refresh'){load();return;}
    if(b.id==='dataset-upload-pause'){controller?.abort();return;}
    if(b.id==='dataset-upload-discard'){
      if(!active?.uploadId||uploadBusy||discardBusy)return;const expected=account(),target={...active};discardBusy=true;b.disabled=true;controls();
      try{let result=await store.call('datasets.upload.discard',{machine:target.machine,uploadId:target.uploadId});if(!current(expected))return;active={...result,machine:target.machine};controls();while(result.state==='DISCARDING'){section.querySelector('#dataset-upload-status').textContent='正在取消未完成上传…';await new Promise(resolve=>setTimeout(resolve,1500));if(!current(expected))return;result=await store.call('datasets.upload.status',{machine:target.machine,uploadId:target.uploadId});if(!current(expected))return;active={...result,machine:target.machine};}section.querySelector('#dataset-upload-status').textContent=result.state==='DISCARDED'?'未完成上传已取消。':result.error||'取消结果尚未确认，请重新检查。';}
      catch(error){if(current(expected))toast(error.message);}finally{if(current(expected)){discardBusy=false;b.disabled=false;controls();}}return;
    }
    const machine=section.querySelector('[name=dataset-machine]').value;
    if(b.dataset.prepareDataset){b.disabled=true;try{const result=await store.call('datasets.prepare',{machine,dataset:b.dataset.prepareDataset,version:b.dataset.version});toast(result.state==='READY'?'数据已经就绪。':'已开始后台准备。完成前不占 GPU，可稍后刷新查看。');await load();}catch(error){toast(error.message);b.disabled=false;}}
    if(b.dataset.useDataset){
      document.querySelector('[data-nav=work]').click();
      const form=document.querySelector('#train-form');if(!form)return;
      form.elements.machine.value=machine;form.elements.datasets.value=b.dataset.useDataset+'@'+b.dataset.version;
      form.elements.datasets.dispatchEvent(new Event('input',{bubbles:true}));form.closest('details').open=true;form.elements.command.focus();
    }
  });
  return ()=>{
    const machines=store.data?.machines||[];
    const next=account(),ids=JSON.stringify(machines.map(m=>m.id));
    if(next!==identity){controller?.abort();controller=null;uploadBusy=false;discardBusy=false;active=null;identity=next;generation++;busy=false;machineIds='';
      section.innerHTML=`<p class="muted datasets-intro">上传自己的数据，或准备已分配的数据。就绪后，训练只读访问本机副本。</p>
        <div class="terminal-controls datasets-controls"><label>服务器<select name="dataset-machine"></select></label><button class="button" id="datasets-refresh">加载 / 刷新数据集</button></div>
        <form id="dataset-upload-form" aria-labelledby="dataset-upload-heading">
          <div class="dataset-upload-heading"><h3 id="dataset-upload-heading">上传我的数据集</h3><p class="muted">仅自己可用，保存到所选服务器；不会自动分享或跨机同步。</p></div>
          <div class="dataset-upload-fields">
            <label class="field">数据集名称<input name="dataset-name" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,39}" placeholder="my-data" aria-describedby="dataset-name-help" required><small id="dataset-name-help">1–40 位字母、数字、下划线或连字符。</small></label>
            <label class="field">本机目录<input type="file" name="dataset-directory" webkitdirectory multiple aria-describedby="dataset-directory-help"><small id="dataset-directory-help">选择整个目录；网页上传不包含空目录。</small></label>
          </div>
          <div class="file-actions dataset-upload-actions"><button class="button primary" type="submit" id="dataset-upload-start">上传 / 继续</button><button class="button" type="button" id="dataset-upload-pause" hidden>暂停传输</button><button class="button" type="button" id="dataset-upload-discard" hidden>取消未完成上传</button></div>
          <div class="dataset-upload-feedback"><progress id="dataset-upload-progress" aria-label="数据集上传进度" hidden></progress><p id="dataset-upload-status" role="status">选择目录后开始；同一目录可断点续传。</p></div>
          <div class="dataset-upload-notes"><p class="muted">关闭页面会停止传输，已开始的服务器校验会继续。</p><p class="muted">大目录建议使用 <code>gpuctl data upload</code>。</p></div>
        </form>
        <p id="datasets-status" role="status">${!store.principal?'请先登录。':!machines.length?'当前没有已授权机器。':'选择服务器，再加载数据集。'}</p><div id="dataset-catalog" class="dataset-catalog"></div>`;
    }
    if(ids!==machineIds){const select=section.querySelector('[name=dataset-machine]'),selected=select.value;select.innerHTML=machines.map(m=>`<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('');if(machines.some(m=>m.id===selected))select.value=selected;else if(selected){controller?.abort();active=null;generation++;busy=false;section.querySelector('#dataset-catalog').replaceChildren();}machineIds=ids;}
    controls();
  };
}
