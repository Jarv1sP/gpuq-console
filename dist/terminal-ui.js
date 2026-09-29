export function terminalContext({machine,project,hostAdmin=false}){
  if(typeof machine!=='string'||!machine||machine==='auto')throw Error('先选择一台服务器，再打开终端。');
  if(project!==undefined&&project!==''&&(typeof project!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(project)))throw Error('项目名称无效。');
  if(project&&hostAdmin)throw Error('项目终端不能使用宿主机 ROOT 模式。');
  return {machine,hostAdmin:hostAdmin===true,...(project?{project}:{})};
}

export function terminalUI(store,toast){
  // xterm needs a response-specific CSP nonce for its dynamic sizing styles.
  const nonce=document.querySelector('meta[name="gpuq-style-nonce"]')?.content;
  const terminalDocument=new Proxy(document,{get(target,key){
    if(key==='createElement')return(...args)=>{const element=target.createElement(...args);if(nonce&&element.tagName==='STYLE')element.nonce=nonce;return element;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  let dialog,term,fit,session,timer,busy=false,input=new Uint8Array(),offset=0,closing=false,lastSize='',generation=0,currentActor=null;
  const sessions=new Map();
  const identity=value=>JSON.stringify([value.userId,value.machine,value.project||'',value.hostAdmin===true]);
  const args=value=>{const {userId,...request}=value;return request;};
  function announce(){document.dispatchEvent(new CustomEvent('gpuq-terminal-state',{detail:{sessions:[...sessions.values()].filter(value=>value.userId===store.principal?.userId).map(value=>({...value}))}}));}
  function detach(){clearTimeout(timer);generation++;session=null;input=new Uint8Array();dialog?.close();}
  store.onAuthChange?.(async call=>{
    const targets=[...sessions.values()].filter(value=>value.userId===currentActor);currentActor=null;detach();announce();
    for(const target of targets)try{await call('terminal.close',args(target));sessions.delete(identity(target));}catch{toast('旧终端关闭未确认；请原账号重新登录后结束该终端，服务端仍按期限回收。');}
  });
  function enqueue(text){const data=new TextEncoder().encode(text);if(input.length+data.length>1048576){toast('终端待发送内容过多；请等待发送完成后再粘贴。');return;}const next=new Uint8Array(input.length+data.length);next.set(input);next.set(data,input.length);input=next;}
  async function closeSession(target){
    await store.call('terminal.close',args(target));sessions.delete(identity(target));
    if(session?.id===target.id)detach();announce();
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
    }catch(error){if(turn===generation){term?.writeln('\r\n[连接中断：'+error.message+'；断开后可重新连接，发布前仍需结束终端]');clearTimeout(timer);}return;}
    finally{busy=false;if(turn!==generation&&session&&!closing)timer=setTimeout(exchange,70);}
    if(turn===generation&&session)timer=setTimeout(exchange,750);
  }
  function ensureDialog(){
    if(dialog)return;dialog=document.createElement('dialog');dialog.className='terminal-dialog';
    dialog.innerHTML='<div class="modal-head"><h2 id="terminal-title"></h2><div><button class="button" id="terminal-interrupt">Ctrl+C</button> <button class="button" id="terminal-disconnect">断开</button> <button class="button danger" id="terminal-stop">结束终端</button></div></div><div id="terminal-screen"></div><p class="muted">开发终端不分配 GPU。断开会保留会话；项目发布前必须选择“结束终端”。无输入 1 小时或累计 6 小时会自动结束。</p>';
    document.body.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();detach();});
  }
  document.addEventListener('gpuq-workspace-context',event=>{
    const userId=event.detail.userId;
    if(currentActor!==userId){currentActor=userId;detach();announce();}
  });
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.id==='terminal-open'){
      button.disabled=true;
      try{
        const target=terminalContext({machine:document.querySelector('[name=terminal-machine]').value,project:document.querySelector('[name=workspace-project]')?.value,hostAdmin:document.querySelector('[name=terminal-host]')?.checked===true});
        if(target.hostAdmin&&!window.confirm('打开真实宿主机 root 终端？这里的修改会影响整台服务器和其他用户。'))return;
        const userId=store.principal?.userId,authGeneration=store.authGeneration;if(!userId)throw Error('请先登录。');
        const key=identity({...target,userId});let retained=sessions.get(key);
        if(!retained)await store.call('terminal.open',{...target,key:crypto.randomUUID()},{
          accept:result=>{retained={...target,id:result.id,userId};sessions.set(key,retained);announce();},
          onStale:async(result,call)=>{const previous={...target,id:result.id,userId};try{await call('terminal.close',args(previous));}catch(error){sessions.set(key,previous);throw error;}}
        });
        if(authGeneration!==store.authGeneration||currentActor!==userId)throw Error('登录账号已改变，未在新账号下附加旧终端。');
        if(document.querySelector('[name=workspace-machine]')?.value!==target.machine||(document.querySelector('[name=workspace-project]')?.value||'')!==(target.project||'')){toast('终端保留在原工作区；回到该服务器与项目可重新连接或结束。');return;}
        session=retained;generation++;offset=0;input=new Uint8Array();closing=false;lastSize='';
        ensureDialog();document.querySelector('#terminal-title').textContent=target.machine+(target.project?' · '+target.project+' · 开发':target.hostAdmin?' · ROOT 宿主机':' · 旧个人工作区');
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
