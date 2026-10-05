import {maintenanceFor,restoreMaintenanceControls,disableMaintenanceControls} from './maintenance-state.js';
// Editable personal data is deliberately separate from verified training data.
// Raw uploads never unpack or publish a dataset automatically.
import {CHUNK_BYTES,LARGE_RELAY_BYTES} from './dataset-upload.js';
import {cloudFilesHTML,cloudFilesUI} from './cloud-files-ui.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const bytesLabel=value=>{const size=value;if(!Number.isFinite(size)||size<0)return '未知';return size<1024**2?(size/1024).toFixed(1)+' KiB':size<1024**3?(size/1024**2).toFixed(1)+' MiB':(size/1024**3).toFixed(2)+' GiB';};
export function workspacePath(value,{root=false}={}){
  if(root&&value==='.')return value;
  if(typeof value!=='string'||!value||new TextEncoder().encode(value).length>1024||/[\\\x00-\x1f\x7f]/.test(value)||value.split('/').some(bit=>!bit||bit==='.'||bit==='..'||new TextEncoder().encode(bit).length>255))throw Error('请填写 /data2 内的相对路径：不含开头斜杠或 ..，总长不超过 1024 字节、每段不超过 255 字节。');
  return value;
}
const alive=signal=>{if(signal?.aborted)throw Error('操作已停止。服务器已收到的文件片段会保留；重新上传前请确认是否覆盖。');};
function base64(bytes){let text='';for(let offset=0;offset<bytes.length;offset+=8192)text+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(text);}
export async function uploadWorkspaceFiles({files,directory='incoming',machine,overwrite=false,signal,call,onProgress=()=>{},allowRelay=false}){
  const selected=Array.from(files||[]),paths=new Set();if(!selected.length)throw Error('请先选择压缩包或文件。');
  const prefix=workspacePath(directory,{root:true}),totalBytes=selected.reduce((sum,file)=>sum+file.size,0);let completed=0;
  for(const file of selected){const name=workspacePath(file.name);if(name.includes('/')||paths.has(name))throw Error('文件名称重复或无效：'+name);paths.add(name);workspacePath(prefix==='.'?name:prefix+'/'+name);if(!Number.isSafeInteger(file.size)||file.size<0)throw Error('文件大小无效。');if(file.size>100*1024**3)throw Error('单个文件最多上传 100 GiB；更大文件请联系管理员线下导入。');}
  if(totalBytes>LARGE_RELAY_BYTES&&allowRelay!==true)throw Error('超过 256 MiB 的文件上传需要确认 VPS 中转；也可改用下载链接让服务器直接下载。');
  for(const file of selected){
    const path=prefix==='.'?file.name:prefix+'/'+file.name;let offset=0;
    do{
      alive(signal);const bytes=new Uint8Array(await file.slice(offset,offset+CHUNK_BYTES).arrayBuffer());alive(signal);
      if(bytes.length!==Math.min(CHUNK_BYTES,file.size-offset))throw Error('文件读取不完整；已停止上传。');
      // No automatic retry: a lost response may follow a durable write.
      const result=await call('datasets.workspace.put',{machine,path,offset,data:base64(bytes),truncate:offset===0&&overwrite});alive(signal);
      if(result.path!==path||result.size!==offset+bytes.length)throw Error('服务器没有确认这段文件的写入结果；请刷新检查，不会自动重复上传。');
      offset=result.size;onProgress({path,bytes:completed+offset,totalBytes});
    }while(offset<file.size);
    completed+=file.size;
  }
  return {files:selected.length,bytes:completed};
}
export function workspaceEntriesHTML(result){
  const parent=result?.path||'.';
  return (result?.entries||[]).map(entry=>{
    const path=parent==='.'?entry.name:parent+'/'+entry.name;
    return `<li><span>${entry.type==='directory'?'目录':'文件'}</span><code>${esc(entry.name)}</code><small>${entry.type==='directory'?'':esc(bytesLabel(entry.size))}</small>${entry.type==='directory'?`<button class="button" type="button" data-workspace-path="${esc(path)}">打开</button>`:''}</li>`;
  }).join('')||'<li class="data-workspace-empty">此目录为空。可上传文件，或在数据终端里创建目录。</li>';
}
export function publicationText(status){
  if(status.state==='READY')return `已发布：${status.dataset}@${status.version}。可在数据集目录选择用于训练。`;
  if(status.state==='FAILED')return '发布失败：'+(status.error||'请检查目录后重试。');
  if(status.state==='UNKNOWN')return '发布结果尚未确认，数据空间暂不可编辑。请联系管理员检查后台发布进程；不要重复发布。';
  if(status.state==='NOT_READY')return '这次发布的本机副本已不再就绪。原始数据仍保留，可从个人数据空间重新发布子目录。';
  if(status.state==='UNREGISTERED')return '这次发布的数据集登记已删除。原始数据仍保留，可从个人数据空间重新发布子目录。';
  if(status.state==='UNAVAILABLE')return '当前账号已无权使用这次发布的数据集。请联系管理员确认授权；原始个人目录不受影响。';
  return '服务器正在扫描、复制并校验文件；可离开页面，后台会继续。';
}
export function dataWorkspaceHTML(){
  return `<section class="data-workspace-card" aria-labelledby="data-workspace-heading">
    <header><div><p class="data-workspace-eyebrow">个人数据空间</p><h3 id="data-workspace-heading">在 /data2 整理，再发布</h3></div><span class="data-workspace-badge">不占用 GPU</span></header>
    <p class="muted">这里只有你在所选服务器上的文件。上传压缩包后，可在终端手动解压；不会自动解压或跨机同步。</p>
    <ol class="data-workspace-steps"><li>上传文件</li><li>终端整理</li><li>发布数据集</li></ol>
    <form id="data-workspace-upload-form">
      <aside class="dataset-route" aria-label="个人数据上传通道"><div class="dataset-route-heading"><span class="dataset-route-label">经门户中转</span><span class="dataset-route-path"><span>本机</span><i aria-hidden="true">→</i><span>平台中转</span><i aria-hidden="true">→</i><span>个人数据空间</span></span></div><p>这里上传的文件经过平台中转。大文件可改用“下载链接”，由服务器直接下载。</p></aside>
      <div class="data-workspace-fields"><label class="field">压缩包或文件<input name="data-workspace-files" type="file" multiple required><small>单个文件最多 100 GiB；不会自动解压。</small></label><label class="field">保存目录<input name="data-workspace-upload-path" value="incoming" placeholder="incoming" required><small>相对 /data2 的路径；缺少的目录会自动创建。</small></label></div>
      <label class="data-workspace-overwrite"><input type="checkbox" name="data-workspace-overwrite">覆盖所选文件在此目录里的同名文件</label>
      <div id="data-workspace-relay-warning" class="dataset-relay-warning" hidden><label><input type="checkbox" name="data-workspace-relay-consent"><span>我确认通过 VPS 中转上传这 <strong id="data-workspace-relay-size"></strong> 文件</span></label><p>所选文件合计超过 256 MiB；中转带宽由所有用户共享，速度可能较慢。</p></div>
      <div class="file-actions"><button class="button" id="data-workspace-upload" type="submit">上传到数据空间</button><button class="button" id="data-workspace-cancel" type="button" hidden>停止传输</button></div>
      <progress id="data-workspace-progress" hidden aria-label="个人数据上传进度"></progress>
    </form>
    <div class="data-workspace-terminal"><div><h4>手动整理</h4><p class="muted">终端中的 <code>/data2</code> 就是这里。用 <code>tar</code>、<code>unzip</code> 等命令处理文件。</p></div><div class="file-actions"><button class="button" id="terminal-data-open" type="button">新建数据终端</button><button class="button quiet" id="terminal-data-reconnect" type="button">重连</button></div></div>
    <details class="data-workspace-browser"><summary>查看文件与发布进度</summary><div class="data-workspace-browse-controls"><label class="field">目录<input name="data-workspace-browse-path" value="." aria-label="查看数据空间目录"></label><button class="button" id="data-workspace-refresh" type="button">刷新</button></div><ul id="data-workspace-files-list"></ul></details>
    <form id="data-workspace-publish-form"><h4>发布为训练数据集</h4><p class="muted">先结束此机器上的所有数据终端，再发布整理好的子目录。发布会复制并校验文件，训练使用只读版本；原目录保留。</p><div class="data-workspace-fields"><label class="field">整理好的子目录<input name="data-workspace-publish-path" placeholder="my-data" required><small>例如 /data2/my-data，填写 my-data。</small></label><label class="field">数据集名称<input name="data-workspace-name" placeholder="my-data" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,39}" required></label></div><div class="file-actions"><button class="button primary" id="data-workspace-publish" type="submit">校验并发布</button></div></form>
    ${cloudFilesHTML()}
    <p id="data-workspace-status" role="status">上传只保存文件；数据整理完成后再发布。</p>
    <p class="muted data-workspace-footnote">上传前请确认磁盘容量；停止上传会保留已收到的文件片段。</p>
  </section>`;
}
export function dataWorkspaceUI(store,section,toast,{onBusyChange=()=>{},refreshCatalog=()=>{}}={}){
  const cloud=cloudFilesUI(store,section,toast);
  let epoch=0,working=false,controller=null;
  const element=selector=>section.querySelector(selector);
  const machine=()=>element('[name=dataset-machine]')?.value;
  const context=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration,machine(),epoch]);
  const valid=expected=>expected===context();
  function relayChoice(reset=false){
    const input=element('[name=data-workspace-files]'),warning=element('#data-workspace-relay-warning'),consent=element('[name=data-workspace-relay-consent]');if(!input||!warning||!consent)return;
    const total=Array.from(input.files||[]).reduce((sum,file)=>sum+file.size,0);warning.hidden=total<=LARGE_RELAY_BYTES;
    element('#data-workspace-relay-size').textContent=bytesLabel(total);if(reset)consent.checked=false;
  }
  function controls(){
    const card=section.querySelector('.data-workspace-card:not(.cloud-import)');if(!card)return;restoreMaintenanceControls(card);relayChoice();
    const enabled=store.production&&store.principal&&machine(),external=element('#dataset-upload-pause')?.hidden===false;
    for(const node of section.querySelectorAll('.data-workspace-card input,.data-workspace-card button'))node.disabled=!enabled||working||external;
    disableMaintenanceControls(card,'#data-workspace-upload,#data-workspace-publish,#terminal-data-open,#terminal-data-reconnect,#cloud-files-form [type=submit],[data-cloud-verify],[data-cloud-restore]',maintenanceFor(store.data?.operationalMaintenance,machine()));
    const stop=element('#data-workspace-cancel');if(stop){stop.hidden=!controller;stop.disabled=!controller;}
    cloud.controls(working||external);
  }
  function reset(){epoch++;controller?.abort();controller=null;working=false;cloud.reset();relayChoice(true);onBusyChange();}
  async function run(action){
    if(working||!store.production||!store.principal||!machine())return;
    const expected=context();working=true;onBusyChange();controls();
    const check=()=>{if(!valid(expected))throw Error('账号或服务器已改变；旧操作已停止。');};
    const call=async(operation,args)=>{check();const result=await store.call(operation,args);check();return result;};
    const report=message=>{check();element('#data-workspace-status').textContent=message;};
    try{await action({expected,check,call,report,machine:machine()});}
    catch(error){if(valid(expected)){element('#data-workspace-status').textContent=error.message;toast(error.message);}}
    finally{if(valid(expected)){working=false;controller=null;onBusyChange();controls();}}
  }
  async function refresh({call,report,machine}){
    const path=workspacePath(element('[name=data-workspace-browse-path]').value.trim(),{root:true});
    const listing=await call('datasets.workspace.list',{machine,path});element('#data-workspace-files-list').innerHTML=workspaceEntriesHTML(listing);
    const status=await call('datasets.workspace.status',{machine});
    if(status.operationId||status.state!=='EDITABLE')report(publicationText(status));
    else report('个人目录已刷新。这里的文件可编辑，已发布的数据集不会随之改变。');
    if(status.state==='READY')await refreshCatalog();
  }
  section.addEventListener('submit',event=>{
    if(!['data-workspace-upload-form','data-workspace-publish-form'].includes(event.target.id))return;event.preventDefault();
    const form=event.target;
    if(form.id==='data-workspace-upload-form')return run(async({call,report,machine,check})=>{
      const files=Array.from(form.elements['data-workspace-files'].files||[]),directory=workspacePath(form.elements['data-workspace-upload-path'].value.trim(),{root:true}),overwrite=form.elements['data-workspace-overwrite'].checked;
      const allowRelay=form.elements['data-workspace-relay-consent'].checked===true;
      if(files.reduce((sum,file)=>sum+file.size,0)>LARGE_RELAY_BYTES&&!allowRelay)throw Error('请先确认 VPS 中转上传，或改用下载链接导入。');
      if(overwrite&&!window.confirm('覆盖所选文件在目标目录里的同名文件？它们的旧内容将被替换，不能撤销。'))return;
      controller=new AbortController();controls();const progress=element('#data-workspace-progress');progress.hidden=false;progress.value=0;
      const result=await uploadWorkspaceFiles({files,directory,machine,overwrite,allowRelay,signal:controller.signal,call,onProgress:value=>{check();report('正在上传 '+value.path+' · '+bytesLabel(value.bytes)+' / '+bytesLabel(value.totalBytes));progress.max=Math.max(1,value.totalBytes);progress.value=value.totalBytes?value.bytes:1;}});
      check();report(`已上传 ${result.files} 个文件。打开数据终端手动解压、整理后，再发布子目录。`);progress.value=progress.max=1;toast('文件已保存到个人数据空间。');
    });
    return run(async({call,report,machine,check})=>{
      const path=workspacePath(form.elements['data-workspace-publish-path'].value.trim()),name=form.elements['data-workspace-name'].value.trim();
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name))throw Error('名称需为 1–40 位字母、数字、下划线或连字符。');
      let result=await call('datasets.workspace.publish',{machine,path,name,key:crypto.randomUUID()});
      if(!result.operationId)throw Error('发布编号未确认。请用“刷新”查询后台状态，不要重复提交。');
      report(publicationText(result));
      // Six minutes of foreground progress, then require an explicit refresh.
      for(let count=0;result.state==='PUBLISHING'&&count<240;count++){await new Promise(resolve=>setTimeout(resolve,1500));check();result=await call('datasets.workspace.status',{machine,operationId:result.operationId});report(publicationText(result));}
      if(result.state==='READY'){toast('数据集已发布，可用于训练。');await refreshCatalog();}
      else if(result.state==='PUBLISHING')report('发布仍在后台进行。稍后点击“刷新”查看结果，不要重复提交。');
    });
  });
  section.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.id==='data-workspace-cancel'){controller?.abort();return;}
    if(button.dataset.workspacePath){element('[name=data-workspace-browse-path]').value=button.dataset.workspacePath;return run(refresh);}
    if(button.id==='data-workspace-refresh')return run(refresh);
  });
  section.addEventListener('change',event=>{if(event.target.name==='data-workspace-files')relayChoice(true);});
  return {get busy(){return working;},controls,reset};
}
