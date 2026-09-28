export function terminalUI(store,toast){
  // xterm creates theme/measurement styles dynamically. Give only those styles
  // the response-specific CSP nonce via its supported documentOverride option.
  const nonce=document.querySelector('meta[name="gpuq-style-nonce"]')?.content;
  const terminalDocument=new Proxy(document,{get(target,key){
    if(key==='createElement')return(...args)=>{const element=target.createElement(...args);if(nonce&&element.tagName==='STYLE')element.nonce=nonce;return element;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  let dialog,term,fit,session,timer,busy=false,input=new Uint8Array(),offset=0,closing=false,lastSize='';
  function enqueue(text){const data=new TextEncoder().encode(text);if(input.length+data.length>1048576){toast('终端待发送内容过多；请等待发送完成后再粘贴。');return;}const next=new Uint8Array(input.length+data.length);next.set(input);next.set(data,input.length);input=next;}
  async function exchange(){
    if(!session||busy||closing)return;busy=true;
    try{const bytes=input.slice(0,8192);input=input.slice(bytes.length);const size={cols:term.cols,rows:term.rows},sizeKey=JSON.stringify(size);const result=await store.call('terminal.exchange',{...session,offset,input:btoa(String.fromCharCode(...bytes)),...(sizeKey===lastSize?{}:size)});lastSize=sizeKey;if(result.data)term.write(Uint8Array.from(atob(result.data),c=>c.charCodeAt(0)));offset=result.offset;if(result.exited){term.writeln('\r\n[终端已退出]');clearTimeout(timer);return;}}
    catch(e){term.writeln('\r\n[连接中断：'+e.message+'；可关闭后重新连接]');clearTimeout(timer);return;}
    finally{busy=false;}timer=setTimeout(exchange,750);
  }
  document.addEventListener('click',async e=>{
    const button=e.target.closest('button');if(!button)return;
    if(button.id==='terminal-open'){
      const machine=document.querySelector('[name=terminal-machine]').value,hostAdmin=document.querySelector('[name=terminal-host]')?.checked===true;
      if(hostAdmin&&!window.confirm('打开真实宿主机 root 终端？这里的修改会影响整台服务器和其他用户。'))return;
      button.disabled=true;
      try{
        const result=await store.call('terminal.open',{machine,key:crypto.randomUUID(),hostAdmin});session={machine,id:result.id,hostAdmin};offset=0;input=new Uint8Array();closing=false;lastSize='';
        if(!dialog){dialog=document.createElement('dialog');dialog.className='terminal-dialog';dialog.innerHTML='<div class="modal-head"><h2 id="terminal-title"></h2><div><button class="button" id="terminal-interrupt">Ctrl+C</button> <button class="button" id="terminal-disconnect">断开</button> <button class="button danger" id="terminal-stop">结束终端</button></div></div><div id="terminal-screen"></div><p class="muted">断开保留会话；无输入 1 小时或累计 6 小时自动结束。训练请提交 GPUQ，不依赖终端保持。</p>';document.body.append(dialog);dialog.addEventListener('cancel',()=>{clearTimeout(timer);session=null;});}
        document.querySelector('#terminal-title').textContent=machine+(hostAdmin?' · ROOT 宿主机':' · 个人工作区');dialog.showModal();term?.dispose();term=new globalThis.Terminal({documentOverride:terminalDocument,cursorBlink:true,fontSize:14,scrollback:3000,theme:{background:'#111827',foreground:'#e5e7eb'},allowProposedApi:false});fit=new globalThis.FitAddon.FitAddon();term.loadAddon(fit);term.open(document.querySelector('#terminal-screen'));fit.fit();term.onData(data=>{enqueue(data);clearTimeout(timer);timer=setTimeout(exchange,70);});term.focus();exchange();
      }catch(e){toast(e.message);}finally{button.disabled=false;}
    }
    if(button.id==='terminal-interrupt'){enqueue('\x03');clearTimeout(timer);exchange();}
    if(button.id==='terminal-disconnect'){clearTimeout(timer);session=null;dialog.close();}
    if(button.id==='terminal-stop'&&session){closing=true;clearTimeout(timer);try{await store.call('terminal.close',session);session=null;dialog.close();}catch(e){toast(e.message);closing=false;}}
  });
  window.addEventListener('resize',()=>{if(dialog?.open)fit?.fit();});
}
