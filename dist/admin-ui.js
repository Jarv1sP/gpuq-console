// Section modules own their requests and controls. The frame owns access and lifetime.
export const ADMIN_SECTIONS=Object.freeze([
  {id:'tasks',title:'显卡与任务',order:10},
  {id:'storage',title:'数据与存储',order:20},
  {id:'members',title:'成员与额度',order:30},
  {id:'maintenance',title:'维护',order:40},
].map(Object.freeze));
const validId=id=>typeof id==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(id);
export function createAdminRegistry(){
  const sections=new Map(),listeners=new Set();
  const notify=()=>{for(const listener of listeners)listener();};
  return {
    register(section){
      if(!section||!validId(section.id)||typeof section.mount!=='function'||!Number.isFinite(section.order)||
        section.unmount!==undefined&&typeof section.unmount!=='function')throw new TypeError('无效的后台区块');
      const title=section.title??ADMIN_SECTIONS.find(row=>row.id===section.id)?.title;
      if(typeof title!=='string'||!title.trim())throw new TypeError('后台区块需要标题');
      if(sections.has(section.id))throw new Error('后台区块已注册：'+section.id);
      const definition=Object.freeze({...section,title});sections.set(section.id,definition);notify();
      return ()=>{if(sections.get(section.id)!==definition)return;sections.delete(section.id);notify();};
    },
    list(){return [...new Map([...ADMIN_SECTIONS,...sections.values()].map(row=>[row.id,row])).values()]
      .sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));},
    get:id=>sections.get(id),
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  };
}
const registry=createAdminRegistry();
export const registerAdminSection=section=>registry.register(section);
export function adminSectionForRoute(route){
  const value=String(route??'').replace(/^#/,'');
  return /^admin\/[a-z][a-z0-9-]{0,63}$/.test(value)?value.slice(6):ADMIN_SECTIONS[0].id;
}
export const adminHashForRoute=route=>String(route??'').replace(/^#/,'')==='admin'?'#admin':'#admin/'+adminSectionForRoute(route);

export function createAdminUI(store,{getPage,navigate,toast},sections=registry){
  const q=selector=>document.querySelector(selector),root=q('#page-admin'),frame=q('#admin-frame'),denied=q('#admin-denied'),
    navigation=q('#admin-sections'),content=q('#admin-content'),empty=q('#admin-empty'),emptyTitle=q('#admin-empty-title'),emptyNote=q('#admin-empty-note');
  let mounted=null,navSignature='',selectedSection=null;
  const identity=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
  const permitted=()=>!!store.principal&&store.principal.role==='admin'&&!store.authPending;
  function stop(){
    const previous=mounted;if(!previous)return;mounted=null;
    previous.controller.abort(new DOMException('后台区块已关闭','AbortError'));
    previous.listeners.clear();
    try{previous.definition.unmount?.();}catch{console.warn('后台区块卸载未完成');}
    previous.el.remove();
  }
  function renderNavigation(id){
    const rows=sections.list(),signature=JSON.stringify(rows.map(({id,title,order})=>({id,title,order})));
    if(signature!==navSignature){
      navSignature=signature;navigation.replaceChildren();
      for(const [index,row] of rows.entries()){
        const link=document.createElement('a');link.href='#admin/'+row.id;link.dataset.adminSection=row.id;
        const number=document.createElement('span');number.className='admin-section-number';number.setAttribute('aria-hidden','true');number.textContent=String(index+1).padStart(2,'0');
        const title=document.createElement('span');title.textContent=row.title;link.append(number,title);navigation.append(link);
      }
    }
    for(const link of navigation.children){const current=link.dataset.adminSection===id;link.classList.toggle('active',current);if(current)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
    return rows.find(row=>row.id===id);
  }
  function update(){
    const active=getPage()==='admin',allowed=permitted();
    if(!active||!allowed){stop();content.replaceChildren();}
    frame.hidden=!allowed;denied.hidden=allowed;
    if(!active||!allowed)return;
    const id=adminSectionForRoute(location.hash),row=renderNavigation(id),definition=sections.get(id),key=identity();selectedSection=id;
    root.dataset.adminCurrentSection=id;emptyTitle.textContent=row?.title||'找不到这个区块';
    emptyNote.textContent=row?'这个区块正在准备。':'请选择一个管理区块。';
    empty.hidden=!!definition;
    if(!definition){stop();content.replaceChildren();return;}
    if(mounted?.key===key&&mounted.definition===definition){for(const listener of mounted.listeners){try{listener();}catch{console.warn('后台区块更新未完成');}}return;}
    stop();content.replaceChildren();
    const controller=new AbortController(),el=document.createElement('div'),listeners=new Set();el.className='admin-section-host';content.append(el);
    const entry={definition,key,controller,el,listeners};mounted=entry;
    const current=()=>mounted===entry&&!controller.signal.aborted&&permitted()&&getPage()==='admin'&&identity()===key;
    const ctx=Object.freeze({store,signal:controller.signal,principal:Object.freeze({...store.principal}),
      toast:message=>{if(current())toast(message);},
      navigate:route=>{if(current())navigate(route);},
      subscribe(listener){if(typeof listener!=='function')throw new TypeError('需要更新函数');if(!current())return()=>{};listeners.add(listener);listener();return()=>listeners.delete(listener);},
    });
    const failed=()=>{if(!current())return;const message=document.createElement('p'),retry=document.createElement('button');
      message.textContent='暂时无法显示这个区块。';retry.type='button';retry.className='button quiet';retry.textContent='重新打开';
      retry.addEventListener('click',()=>{if(current()){stop();update();}});el.replaceChildren(message,retry);};
    try{
      const pending=definition.mount(el,ctx);
      Promise.resolve(pending).catch(failed);
    }catch{failed();}
  }
  const onClick=event=>{const link=event.target.closest('[data-admin-section]');if(!link||!navigation.contains(link))return;event.preventDefault();navigate(link.getAttribute('href'));};
  navigation.addEventListener('click',onClick);
  const unsubscribe=sections.subscribe(update),authCleanup=store.onAuthChange?.(()=>{stop();frame.hidden=true;denied.hidden=false;});
  return {update,dispose(){stop();unsubscribe();authCleanup?.();navigation.removeEventListener('click',onClick);},currentSection:()=>selectedSection};
}
