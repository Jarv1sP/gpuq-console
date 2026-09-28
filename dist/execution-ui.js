const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const terminal=new Set(['SUCCEEDED','FAILED','CANCELED']);
export function executionUI(store,refresh,toast){
  let section,log,identity=null,submitKey=crypto.randomUUID();
  const call=(op,args)=>store.call(op,args);
  const option=m=>`<option value="${escape(m.id)}">${escape(m.id)}</option>`;
  async function guarded(button,fn){button.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{button.disabled=false;}}
  document.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.dataset.jobLogs)guarded(b,async()=>{const r=await call('jobs.logs',{jobId:b.dataset.jobLogs});log.querySelector('pre').textContent=r.text;log.showModal();});
    if(b.dataset.jobCancel&&window.confirm('取消这个训练任务？已保存的文件保留，确认停止后才释放额度。'))guarded(b,async()=>{await call('jobs.cancel',{jobId:b.dataset.jobCancel});refresh();toast('已请求取消；等待 GPUQ 确认释放。');});
    if(b.id==='close-job-log')log.close();
    if(b.id==='workspace-list')guarded(b,async()=>{
      const machine=section.querySelector('[name=file-machine]').value,path=section.querySelector('[name=file-path]').value||'.';
      const r=await call('files.list',{machine,path});section.querySelector('#workspace-result').textContent=r.entries.map(f=>`${f.type==='directory'?'[目录]':'[文件]'} ${f.name}  ${f.type==='file'?f.size+' B':''}`).join('\n')||'目录为空';
    });
    if(b.id==='workspace-upload')guarded(b,async()=>{
      const machine=section.querySelector('[name=file-machine]').value,dir=section.querySelector('[name=file-path]').value||'.';
      const files=section.querySelector('[name=files]').files;if(!files.length)throw Error('先选择文件。');
      for(const file of files){let offset=0;do{const bytes=new Uint8Array(await file.slice(offset,offset+1048576).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));await call('files.put',{machine,path:dir==='.'?file.name:dir+'/'+file.name,offset,truncate:offset===0,data:btoa(binary)});offset+=bytes.length;section.querySelector('#workspace-result').textContent=`正在上传 ${file.name}：${offset} / ${file.size} B`;}while(offset<file.size);}
      toast('文件上传完成。');
    });
    if(b.id==='workspace-download')guarded(b,async()=>{
      const machine=section.querySelector('[name=file-machine]').value,path=section.querySelector('[name=file-path]').value;if(!path||path==='.')throw Error('请填入要下载的文件相对路径。');
      let offset=0,chunks=[];while(true){const r=await call('files.get',{machine,path,offset});const bytes=Uint8Array.from(atob(r.data),c=>c.charCodeAt(0));chunks.push(bytes);offset+=bytes.length;if(offset>100*1024*1024)throw Error('超过 100 MiB，请用 CLI 下载大文件。');if(r.eof)break;}
      const url=URL.createObjectURL(new Blob(chunks)),a=document.createElement('a');a.href=url;a.download=path.split('/').pop();a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
  });
  document.addEventListener('submit',e=>{
    if(e.target.id!=='train-form')return;e.preventDefault();const b=e.target.querySelector('[type=submit]'),f=new FormData(e.target);
    guarded(b,async()=>{await call('jobs.submit',{machine:f.get('machine'),cards:Number(f.get('cards')),minVramGiB:Number(f.get('memory')),name:f.get('name')||'train',argv:['/bin/bash','-c',String(f.get('command'))],key:submitKey});submitKey=crypto.randomUUID();refresh();toast('已提交；服务器继续运行，无需保持此网页打开。');});
  });
  return ()=>{
    if(!store.production)return;
    if(!section){section=document.createElement('section');section.id='execution-workspace';section.className='execution-workspace';document.querySelector('#execution-host').append(section);log=document.createElement('dialog');log.className='job-log-dialog';log.innerHTML='<div class="modal-head"><h2>训练日志 · 最近 200 行</h2><button class="button" id="close-job-log">关闭</button></div><pre></pre>';document.body.append(log);}
    section.hidden=!store.principal;if(section.hidden){identity=null;section.innerHTML='';return;}
    const machines=store.data?.machines||[],jobs=store.jobs.filter(j=>j.userId===store.principal.userId),enabled=store.data?.executionEnabled&&machines.length;
    const nextIdentity=JSON.stringify([store.principal.userId,store.principal.role,machines,enabled]);
    if(identity===nextIdentity){section.querySelector('#my-job-table').innerHTML=taskTable(jobs);section.querySelector('#my-job-count').textContent=jobs.filter(j=>!terminal.has(j.state)).length+' 个待完成任务';return;}identity=nextIdentity;
    const count=jobs.filter(j=>!terminal.has(j.state)).reduce((n,j)=>n+j.cards,0);
    section.innerHTML=`<div class="section-kicker"><span>我的训练任务</span><span id="my-job-count">预留 ${count} 张 · ${jobs.filter(j=>!terminal.has(j.state)).length} 个待完成任务</span></div>
      <p class="muted">任务在服务器运行。排队、运行及待核对任务均占用个人额度；取消确认后释放。新提交使用当前登录账号，不冒用其他用户。<a href="/guide/user" target="_blank">用户手册</a> · ${store.principal.role==='admin'?'<a href="/guide/admin" target="_blank">管理员手册</a>':''}</p>
      <div class="terminal-controls"><label>交互式终端<select name="terminal-machine">${machines.map(option).join('')}</select></label>${store.principal.role==='admin'?'<label><input type="checkbox" name="terminal-host">宿主机 ROOT（不隔离）</label>':'<span class="muted">个人环境安装 / 代码编辑 · 与训练共用 /workspace</span>'}<button id="terminal-open" class="button" ${enabled?'':'disabled'}>打开终端</button></div>
      <details class="execution-panel"><summary>提交训练</summary><form id="train-form"><div class="train-grid"><label>机器<select name="machine"><option value="auto">在获准机器中自动选择</option>${machines.map(option).join('')}</select></label><label>卡数<input name="cards" type="number" min="1" max="${Math.max(1,...machines.map(m=>m.cards))}" value="1" required></label><label>每卡最低显存 / GiB<input name="memory" type="number" min="0" max="128" value="0" step="0.5"></label><label>任务名称<input name="name" maxlength="64" value="train" required></label></div><label>训练命令<textarea name="command" rows="3" required spellcheck="false">python train.py</textarea></label><p class="muted">先将代码上传到所选服务器的个人工作区。命令在 /workspace 运行，标准 Python 在 /opt/conda；不暴露宿主机的共享管理员目录。自动选机时请先把代码和数据准备到候选机器。</p><button type="submit" class="button primary" ${enabled?'':'disabled'}>${enabled?'提交训练':'尚无执行授权'}</button></form></details>
      <details class="execution-panel"><summary>工作区文件 · 上传 / 下载</summary><div class="train-grid"><label>服务器<select name="file-machine">${machines.map(option).join('')}</select></label><label>目录或文件的相对路径<input name="file-path" value="." spellcheck="false"></label></div><div class="file-actions"><button class="button" id="workspace-list" ${enabled?'':'disabled'}>列目录</button><button class="button" id="workspace-download" ${enabled?'':'disabled'}>下载文件</button><input type="file" name="files" multiple aria-label="选择上传文件"><button class="button" id="workspace-upload" ${enabled?'':'disabled'}>上传到目录</button></div><pre id="workspace-result" class="file-result" aria-live="polite">仅能操作自己的工作区；同名上传会覆盖。大目录请使用 CLI。</pre></details>
      <div id="my-job-table">${taskTable(jobs)}</div>`;
  };
}

export function taskTable(jobs){return `<div class="live-table-wrap"><table class="live-table"><thead><tr><th>任务 / 用户</th><th>机器 / 卡数</th><th>状态</th><th>操作</th></tr></thead><tbody>${[...jobs].reverse().map(j=>`<tr><td><strong>${escape(j.name)}</strong><small>${escape(j.username)} · ${escape(j.id)}</small></td><td>${escape(j.machine)}<small>${j.cards} 张${j.assignedIndices?.length?' · GPU '+j.assignedIndices.join(','):''}</small></td><td>${escape(j.state)}${j.cancelRequested&&!terminal.has(j.state)?' · 正在取消':''}<small>${escape(j.error||'')}</small></td><td><button class="button" data-job-logs="${escape(j.id)}">日志</button> <button class="button danger" data-job-cancel="${escape(j.id)}" ${terminal.has(j.state)||j.cancelRequested?'disabled':''}>取消</button></td></tr>`).join('')||'<tr><td colspan="4">暂无任务。先上传代码，再提交训练。</td></tr>'}</tbody></table></div>`;}
