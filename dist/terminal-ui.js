export function terminalContext({machine,project,hostAdmin=false}){
  if(typeof machine!=='string'||!machine||machine==='auto')throw Error('先选择一台服务器，再打开终端。');
  if(project!==undefined&&project!==''&&(typeof project!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(project)))throw Error('项目名称无效。');
  if(project&&hostAdmin)throw Error('项目终端不能使用宿主机 ROOT 模式。');
  return {machine,hostAdmin:hostAdmin===true,...(project?{project}:{})};
}

export function terminalLaunchContext({machine,project,role,entry='development'}){
  if(!['development','host'].includes(entry))throw Error('终端入口无效。');
  if(entry==='host'){
    if(role!=='admin')throw Error('宿主机 ROOT 运维仅管理员可用。');
    return terminalContext({machine,hostAdmin:true});
  }
  return terminalContext({machine,project,hostAdmin:false});
}

export function terminalUI(store,toast){
  // xterm needs a response-specific CSP nonce for its dynamic sizing styles.
  const nonce=document.querySelector('meta[name="gpuq-style-nonce"]')?.content;
  const terminalDocument=new Proxy(document,{get(target,key){
    if(key==='createElement')return(...args)=>{const element=target.createElement(...args);if(nonce&&element.tagName==='STYLE')element.nonce=nonce;return element;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  let dialog,term,fit,session,timer,busy=false,input=new Uint8Array(),offset=0,closing=false,lastSize='',generation=0,currentActor=null,currentWorkspace='',workspaceGeneration=0,openingGeneration=0;
  const sessions=new Map();
  const identity=value=>JSON.stringify([value.userId,value.machine,value.project||'',value.hostAdmin===true]);
  const args=value=>{const {machine,project,hostAdmin,id,clientId,writerToken}=value;return {machine,...(project?{project}:{}),hostAdmin,id,clientId,writerToken};};
  function announce(){document.dispatchEvent(new CustomEvent('gpuq-terminal-state',{detail:{sessions:[...sessions.values()].filter(value=>value.userId===store.principal?.userId).map(({writerToken,...value})=>({...value}))}}));}
  async function detach(release=true,invalidateOpening=true){if(invalidateOpening)openingGeneration++;const previous=session;clearTimeout(timer);generation++;session=null;input=new Uint8Array();dialog?.close();if(previous&&release){previous.detached=true;try{await store.call('terminal.detach',args(previous));}catch{toast('写入权释放未确认；终端仍保留，等待 30 秒或明确接管后重连。');}}}
  store.onAuthChange?.(async call=>{
    const targets=[...sessions.values()].filter(value=>value.userId===currentActor);currentActor=null;detach(false);announce();
    for(const target of targets)try{await call('terminal.detach',args(target));target.detached=true;}catch{toast('旧终端写入权释放未确认；终端未自动关闭，原账号可显式重连。');}
  });
  function enqueue(text){const data=new TextEncoder().encode(text);if(input.length+data.length>1048576){toast('终端待发送内容过多；请等待发送完成后再粘贴。');return;}const next=new Uint8Array(input.length+data.length);next.set(input);next.set(data,input.length);input=next;}
  async function closeSession(target){
    if(target.detached){const result=await store.call('terminal.open',{...args(target),key:crypto.randomUUID(),mode:'reconnect'});target.writerToken=result.writerToken;target.detached=false;}
    await store.call('terminal.close',args(target));sessions.delete(target.id);
    if(session?.id===target.id)detach(false);announce();
  }
  async function exchange(){
    if(!session||busy||closing)return;busy=true;const target=session,turn=generation;
    try{
      const bytes=input.slice(0,8192);input=input.slice(bytes.length);
      const size={cols:term.cols,rows:term.rows},sizeKey=JSON.stringify(size);
      const result=await store.call('terminal.exchange',{...args(target),offset,input:btoa(String.fromCharCode(...bytes)),...(sizeKey===lastSize?{}:size)});
      if(turn!==generation||session?.id!==target.id)return;
      lastSize=sizeKey;if(result.data)term.write(Uint8Array.from(atob(result.data),char=>char.charCodeAt(0)));offset=result.offset;
      if(result.exited){term.writeln('\r\n[终端已退出]');clearTimeout(timer);await closeSession(target);return;}
    }catch(error){if(turn===generation){term?.writeln('\r\n[连接中断：'+error.message+'；断开后可从对应入口重连，会话尚未结束]');clearTimeout(timer);}return;}
    finally{busy=false;if(turn!==generation&&session&&!closing)timer=setTimeout(exchange,70);}
    if(turn===generation&&session)timer=setTimeout(exchange,750);
  }
  function ensureDialog(){
    if(dialog)return;dialog=document.createElement('dialog');dialog.className='terminal-dialog';dialog.setAttribute('aria-labelledby','terminal-title');
    dialog.innerHTML='<div class="modal-head"><h2 id="terminal-title"></h2><div><button class="button" id="terminal-interrupt">Ctrl+C</button> <button class="button" id="terminal-disconnect">断开</button> <button class="button danger" id="terminal-stop">结束终端</button></div></div><div id="terminal-screen"></div><p id="terminal-session-note" class="muted"></p>';
    document.body.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();detach();});
  }
  document.addEventListener('gpuq-workspace-context',event=>{
    const {userId,machine,project}=event.detail,next=JSON.stringify([userId,machine,project||'']);
    if(currentActor!==userId||currentWorkspace!==next){currentActor=userId;currentWorkspace=next;workspaceGeneration++;detach();announce();}
  });
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(['terminal-open','terminal-reconnect','terminal-root-open','terminal-root-reconnect'].includes(button.id)){
      button.disabled=true;
      try{
        const target=terminalLaunchContext({machine:document.querySelector('[name=terminal-machine]').value,project:document.querySelector('[name=workspace-project]')?.value,role:store.principal?.role,entry:button.id.startsWith('terminal-root-')?'host':'development'});
        if(target.hostAdmin&&!window.confirm(`进入 ${target.machine} 的宿主机 ROOT 运维？可修改整机、影响他人任务，并能绕过 GPU 配额。日常开发请使用个人开发终端。`))return;
        const userId=store.principal?.userId,authGeneration=store.authGeneration,workspace=workspaceGeneration;if(!userId)throw Error('请先登录。');
        let retained;const reconnect=button.id.endsWith('-reconnect');
        const matching=[...sessions.values()].filter(value=>identity(value)===identity({...target,userId}));
        const id=reconnect?window.prompt('输入要重连的会话 ID。其他客户端仍持有写入权时不会自动接管。',matching.at(-1)?.id||'')?.trim():null;
        if(reconnect&&!id)return;
        const known=id?sessions.get(id):null;
        if(known&&identity(known)!==identity({...target,userId}))throw Error('会话属于另一台服务器、项目或终端类型；请返回对应入口重连。');
        const clientId=known?.clientId||crypto.randomUUID();
        const request={...target,key:crypto.randomUUID(),clientId,mode:reconnect?'reconnect':'new',...(reconnect?{id,...(known?.writerToken?{writerToken:known.writerToken}:{})}:{})};
        // All four entries share one intent fence. A slow ROOT response must
        // never replace a development terminal opened by a later click.
        const opening=++openingGeneration;
        const current=()=>opening===openingGeneration&&workspace===workspaceGeneration&&authGeneration===store.authGeneration&&currentActor===userId;
        await detach(true,false);if(!current())return;
        const lifecycle={
          accept:result=>{if(!result.writerToken)throw Error('节点终端协议需升级；未发送输入，也未关闭旧终端。');retained={...target,id:result.id,userId,clientId,writerToken:result.writerToken};sessions.set(retained.id,retained);announce();},
          onStale:async(result,call)=>{if(!result.writerToken)return;const previous={...target,id:result.id,userId,clientId,writerToken:result.writerToken};await call('terminal.detach',args(previous));sessions.set(previous.id,{...previous,detached:true});}
        };
        try{await store.call('terminal.open',request,lifecycle);}catch(error){
          if(!current())throw Error('终端打开请求已过期；没有切换当前终端。');
          if(!reconnect||!/active writer|Legacy terminal/.test(error.message)||!window.confirm('明确接管这个终端？原客户端将失去输入和结束权限；已经执行的命令不会撤销。'))throw error;
          await store.call('terminal.open',{...request,key:crypto.randomUUID(),takeover:true},lifecycle);
        }
        if(authGeneration!==store.authGeneration||currentActor!==userId)throw Error('登录账号已改变，未在新账号下附加旧终端。');
        if(!current()){retained.detached=true;try{await store.call('terminal.detach',args(retained));}catch{toast('原终端写入权释放未确认；请回到对应入口显式重连。');}toast('终端选择已改变；旧终端保留在原入口，没有自动连接。');return;}
        session=retained;generation++;offset=0;input=new Uint8Array();closing=false;lastSize='';
        ensureDialog();dialog.classList.toggle('host-terminal-dialog',target.hostAdmin);document.querySelector('#terminal-title').textContent=target.machine+(target.hostAdmin?' · ROOT 运维':target.project?' · '+target.project+' · 个人开发':' · 个人开发')+' · '+retained.id;
        document.querySelector('#terminal-session-note').textContent=target.hostAdmin?'宿主机 ROOT：可修改整机并绕过 GPU 配额，不是个人开发环境。断开保留会话；完成维护请结束终端。':`个人开发终端不分配 GPU。${target.project?'项目发布前请结束终端。':''}断开保留会话；无输入 1 小时或累计 6 小时自动结束。`;
        dialog.showModal();term?.dispose();document.querySelector('#terminal-screen').replaceChildren();
        term=new globalThis.Terminal({documentOverride:terminalDocument,cursorBlink:true,fontSize:14,scrollback:3000,theme:{background:'#111827',foreground:'#e5e7eb'},allowProposedApi:false});
        fit=new globalThis.FitAddon.FitAddon();term.loadAddon(fit);term.open(document.querySelector('#terminal-screen'));fit.fit();
        term.onData(data=>{enqueue(data);clearTimeout(timer);timer=setTimeout(exchange,70);});term.focus();exchange();
      }catch(error){toast(error.message);}finally{button.disabled=false;}
    }
    if(button.id==='terminal-interrupt'){enqueue('\x03');clearTimeout(timer);exchange();}
    if(button.id==='terminal-disconnect')detach();
    if(button.id==='terminal-stop'&&session){closing=true;clearTimeout(timer);button.disabled=true;try{await closeSession(session);}catch(error){toast(error.message);closing=false;}finally{button.disabled=false;}}
    if(button.id==='project-terminal-stop'){
      const machine=document.querySelector('[name=workspace-machine]')?.value,project=document.querySelector('[name=workspace-project]')?.value;
      const targets=[...sessions.values()].filter(value=>value.userId===store.principal?.userId&&value.machine===machine&&value.project===project);
      button.disabled=true;try{for(const target of targets)await closeSession(target);toast('项目开发终端已结束，现在可以发布。');}catch(error){toast(error.message);}finally{button.disabled=false;}
    }
  });
  window.addEventListener('resize',()=>{if(dialog?.open)fit?.fit();});
}
