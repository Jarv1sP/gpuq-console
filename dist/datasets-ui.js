const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={READY:'本机已就绪',REGISTERED:'待准备',STAGING:'未完成，可续传',PREPARING:'准备中',FAILED:'准备失败'};
export function datasetRows(catalog){
  return (catalog?.datasets||[]).flatMap(item=>(item.versions||[]).map(v=>`<article class="dataset-card"><div><h3>${esc(item.dataset)}</h3><p class="muted">${esc(labels[v.state]||v.state)} · ${(Number(v.bytes||0)/1024**3).toFixed(2)} GiB · ${Number(v.files||0)} 个文件</p>${v.error?`<p class="form-error" role="status">${esc(v.error)}</p>`:''}<label class="field">固定版本<input readonly value="${esc(item.dataset+'@'+v.version)}" aria-label="${esc(item.dataset)} 的固定版本" spellcheck="false"></label><p class="muted">训练路径：<code>/data2/${esc(item.dataset)}</code>（只读）</p></div><div class="file-actions"><button class="button" data-prepare-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${['READY','PREPARING'].includes(v.state)?'disabled':''}>准备到本机</button><button class="button primary" data-use-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${v.state==='READY'?'':'disabled'}>用于训练</button></div></article>`)).join('')||'<div class="empty">此机器还没有分配给你的数据集。<br>由管理员登记数据并授权后，即可在这里准备本地副本。</div>';
}
export function datasetsUI(store,toast){
  const section=document.querySelector('#page-datasets');let identity='',generation=0,busy=false;
  async function load(){
    if(busy||!store.principal)return;
    const machine=section.querySelector('[name=dataset-machine]')?.value;if(!machine)return;
    busy=true;const token=++generation,button=section.querySelector('#datasets-refresh'),select=section.querySelector('[name=dataset-machine]');button.disabled=true;select.disabled=true;
    const status=section.querySelector('#datasets-status');status.textContent='正在读取数据集状态…';section.querySelector('#dataset-catalog').replaceChildren();
    try{const result=await store.call('datasets.list',{machine});if(token!==generation)return;section.querySelector('#dataset-catalog').innerHTML=datasetRows(result);status.textContent='已更新。准备数据不占用 GPU。';}
    catch(e){if(token===generation){section.querySelector('#dataset-catalog').replaceChildren();status.textContent=e.message;}}
    finally{if(token===generation){busy=false;button.disabled=false;select.disabled=false;}}
  }
  section.addEventListener('change',e=>{if(e.target.name==='dataset-machine')load();});
  section.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.id==='datasets-refresh'){load();return;}
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
    const next=JSON.stringify([store.principal?.userId,store.principal?.role,machines]);if(next===identity)return;identity=next;generation++;busy=false;
    section.innerHTML=`<p class="muted">选择服务器，准备所需数据版本。就绪后，训练从 <code>/data2/数据集名称</code> 只读访问本地副本。</p><div class="terminal-controls"><label>服务器<select name="dataset-machine">${machines.map(m=>`<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('')}</select></label><button class="button" id="datasets-refresh" ${store.production&&store.principal&&machines.length?'':'disabled'}>加载 / 刷新数据集</button></div><p id="datasets-status" role="status">${!store.principal?'请先登录。':!machines.length?'当前没有已授权机器。':'选择服务器，再加载数据集。'}</p><div id="dataset-catalog" class="dataset-catalog"></div>`;
  };
}
