import {escapeUI as esc} from './workbench-ui.js';
import {controlUI,sessionStatus} from './control-ui.js';
import {sharedObject,captureObject} from './motion-ui.js';

const order={work:0,resources:1,datasets:2,transfers:2,community:3,users:4,me:4,maintenance:4};
export function shellUI(store,{navigate,getPage,toast}){
  const q=selector=>document.querySelector(selector),account=q('#account-menu'),nav=q('#room-nav'),context=q('#shell-context');
  const reduced=()=>matchMedia('(prefers-reduced-motion:reduce)').matches,phone=()=>matchMedia('(max-width:759px)').matches;
  let page=null,roomAnimation=null,headingAnimation=null,ghost=null,contextActor=null,notice='',phoneAction=null,phoneActionPlace=null;
  const scrolls=new Map(),routeSlides=new Map(),indicator=document.createElement('span');indicator.className='nav-indicator';indicator.setAttribute('aria-hidden','true');nav.prepend(indicator);nav.classList.add('has-indicator');
  const control=controlUI(store,{navigate,getPage,toast,openSubmit:()=>document.dispatchEvent(new CustomEvent('gpuq-open-submit')),openJob:(id,view='overview',origin)=>document.dispatchEvent(new CustomEvent('gpuq-open-job',{detail:{id,view,origin}}))});
  function syncContext(){
    const machine=q('[name=workspace-machine]'),project=q('[name=workspace-project]'),active=getPage();
    context.hidden=!store.principal||!machine||!['work','datasets','transfers'].includes(active);
    for(const [original,target] of [[machine,q('#context-machine')],[project,q('#context-project')]]){if(!original)continue;if(target.innerHTML!==original.innerHTML)target.innerHTML=original.innerHTML;target.value=original.value;target.disabled=original.disabled;}
    q('#context-note').textContent=project?.value?'项目':'个人工作区';
    if(active==='work'&&store.principal){q('#page-title').textContent=project?.value||'个人工作区';q('#page-description').textContent=machine?.value?machine.value+' · '+(project?.value?'项目':'个人工作区'):'选择获授权服务器，开始一次训练。';}
  }
  for(const [proxy,name] of [['#context-machine','workspace-machine'],['#context-project','workspace-project']])q(proxy).addEventListener('change',event=>{const original=q(`[name=${name}]`);if(original){original.value=event.target.value;original.dispatchEvent(new Event('change',{bubbles:true}));}});
  document.addEventListener('gpuq-workspace-context',event=>{if(event.detail.userId!==store.principal?.userId)return;queueMicrotask(syncContext);});
  document.addEventListener('gpuq-workspace-rendered',syncContext);
  document.addEventListener('click',event=>{
    if(!account.contains(event.target))account.open=false;
    const action=event.target.closest('[data-shell-action]')?.dataset.shellAction;
    if(action==='profile'){q('#edit-profile').click();account.open=false;}
    if(action==='logout'){q('#switch-account').click();account.open=false;}
    if(action==='new-project'){navigate('work');const target=q('#project-create');if(target){target.open=true;target.scrollIntoView({block:'center',behavior:'instant'});target.querySelector('input')?.focus();}}
    if(action==='terminal')q('#terminal-open')?.click();
    if(action==='members')navigate('users');
    if(action==='guide')q('.guide-link').click();
    if(action==='files'){navigate('work');const target=q('#workspace-files');if(target){target.open=true;target.scrollIntoView({block:'center',behavior:'instant'});}}
    if(event.target.closest('#edit-profile,#switch-account'))account.open=false;
    const server=event.target.closest('[data-use-machine]');if(server){const from=captureObject(server.closest('[data-resource-machine]')?.querySelector('h2'));queueMicrotask(()=>sharedObject(from,q('#context-machine')));}
  });
  function updateIndicator(animate=false){
    const selected=nav.querySelector('.nav-item.active');if(!selected||phone()){indicator.hidden=true;return;}
    indicator.hidden=false;const rect=selected.getBoundingClientRect(),parent=nav.getBoundingClientRect(),previous=indicator.getBoundingClientRect();
    indicator.style.left=rect.left-parent.left+'px';indicator.style.top=rect.top-parent.top+'px';indicator.style.width=rect.width+'px';indicator.style.height=rect.height+'px';
    if(animate&&!reduced()&&previous.width)indicator.animate([{transform:`translateX(${previous.left-rect.left}px) scaleX(${previous.width/rect.width})`},{transform:'none'}],{duration:220,easing:'cubic-bezier(.2,0,0,1)'});
  }
  function syncNavigation(){
    const active=getPage(),selected=phone()?({transfers:'datasets',users:'me',maintenance:'me'}[active]||active):active;
    for(const item of nav.querySelectorAll('[data-nav]')){const current=item.dataset.nav===selected;item.classList.toggle('active',current);if(current)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');}
  }
  function markDesktopSlide(target,animation){
    if(phone()||reduced())return;
    target.classList.add('desktop-route-slide');routeSlides.set(target,animation);
    const clear=()=>{if(routeSlides.get(target)===animation){routeSlides.delete(target);target.classList.remove('desktop-route-slide');}};
    animation.finished.then(clear,clear);
  }
  function route(next,apply){
    const previous=getPage();if(previous===next){apply();return;}
    scrolls.set(previous,scrollY);roomAnimation?.cancel();headingAnimation?.cancel();ghost?.remove();
    const outgoing=q(`[data-page="${CSS.escape(previous)}"]`),rect=outgoing?.getBoundingClientRect(),direction=(order[next]??0)>=(order[previous]??0)?1:-1;
    if(outgoing&&rect.height&&!phone()&&!reduced()){
      ghost=outgoing.cloneNode(true);ghost.removeAttribute('id');ghost.removeAttribute('data-page');ghost.setAttribute('aria-hidden','true');ghost.inert=true;ghost.classList.add('room-ghost');
      const originals=[outgoing,...outgoing.querySelectorAll('*')];for(const [index,element] of [ghost,...ghost.querySelectorAll('*')].entries()){element.removeAttribute('style');for(const name of originals[index].style)element.style.setProperty(name,originals[index].style.getPropertyValue(name));for(const attr of [...element.attributes])if(['id','name','form'].includes(attr.name)||attr.name.startsWith('data-')||attr.name.startsWith('on'))element.removeAttribute(attr.name);}
      const clone=ghost,layer=document.createElement('div');layer.className='room-transition-layer';layer.setAttribute('aria-hidden','true');layer.inert=true;
      clone.style.position='absolute';clone.style.left=rect.left+'px';clone.style.top=rect.top+'px';clone.style.width=rect.width+'px';layer.append(clone);document.body.append(layer);ghost=layer;
      const title=captureObject(q('.page-heading'));if(title){const heading=title.element;heading.style.position='absolute';heading.style.left=title.rect.left+'px';heading.style.top=title.rect.top+'px';heading.style.width=title.rect.width+'px';layer.append(heading);heading.animate([{opacity:1,transform:'none'},{opacity:0,transform:`translateX(${-direction*24}px)`}],{duration:180,easing:'cubic-bezier(.4,0,1,1)'});}
      const exit=clone.animate([{opacity:1,transform:'translateX(0)'},{opacity:0,transform:`translateX(${-direction*24}px)`}],{duration:180,easing:'cubic-bezier(.4,0,1,1)'});exit.finished.then(()=>layer.remove(),()=>layer.remove());
    }
    apply();scrollTo({top:scrolls.get(next)||0,behavior:'instant'});
    const incoming=q(`[data-page="${CSS.escape(next)}"]`);
    if(incoming){roomAnimation=incoming.animate(phone()||reduced()?[{opacity:0},{opacity:1}]:[{opacity:0,transform:`translateX(${direction*24}px)`},{opacity:1,transform:'none'}],{duration:reduced()?150:phone()?200:280,delay:phone()||reduced()?0:60,easing:'cubic-bezier(.2,.8,.2,1)'});markDesktopSlide(incoming,roomAnimation);}
    headingAnimation=q('.page-heading').animate(phone()||reduced()?[{opacity:0},{opacity:1}]:[{opacity:0,transform:`translateX(${direction*24}px)`},{opacity:1,transform:'none'}],{duration:reduced()?150:phone()?200:280,delay:phone()||reduced()?0:60,easing:'cubic-bezier(.2,.8,.2,1)'});
    markDesktopSlide(q('.page-heading'),headingAnimation);
    updateIndicator(true);
  }
  function updateMobileAction(){
    if(phoneAction&&(!phone()||getPage()!=='work')){phoneActionPlace?.after(phoneAction);phoneActionPlace?.remove();phoneActionPlace=null;phoneAction=null;}
    const action=q('#open-submit');
    if(phone()&&getPage()==='work'&&action){if(!phoneAction){phoneActionPlace=document.createComment('workbench primary action');action.before(phoneActionPlace);phoneAction=action;q('#mobile-control').append(action);}action.hidden=!store.principal;}
  }
  function renderMe(){
    const user=store.users.find(row=>row.id===store.principal?.userId),snapshot=control.snapshot(),host=q('#me-content');
    if(!user){host.textContent='登录后查看自己的账号和工作区。';return;}
    host.innerHTML=`<section class="me-hero hero-frame"><span class="hero-label">我的账号</span><h2 class="disp">${esc(user.name||user.username)}</h2><p class="mono">${esc(user.username)} · ${user.role==='admin'?'管理员':'成员'}</p><div class="me-telemetry"><div><span class="label">额度占用 / 上限</span><strong>${snapshot.usage??'—'} / ${snapshot.quota??'—'} <small>张</small></strong></div><div><span class="label">已授权服务器</span><strong>${snapshot.servers.length} <small>台</small></strong></div></div></section><div class="me-actions"><button type="button" class="button quiet" data-shell-action="profile" ${q('#edit-profile').hidden?'hidden':''}>设置姓名</button><button type="button" class="button quiet" data-shell-action="files">个人工作区与文件</button><button type="button" class="button quiet" data-shell-action="control">会话与后台任务</button>${user.role==='admin'?'<button type="button" class="button quiet" data-shell-action="members">成员授权</button>':''}<button class="button quiet" type="button" data-shell-action="guide">使用指南</button><button type="button" class="button quiet" data-shell-action="logout">退出登录</button></div>${snapshot.sessions.length?'<h3 class="me-section-title">保留的终端会话</h3>'+snapshot.sessions.map(session=>`<article class="mc-row"><span class="mono">${esc(session.machine)} · ${esc(session.project||'个人工作区')}</span><p class="muted">${esc(sessionStatus(session))}</p><code class="control-full-id">${esc(session.id)}</code><button type="button" class="button quiet" data-control-session="${esc(session.id)}">${session.detached?'重连':'展开'}终端</button></article>`).join(''):''}`;
  }
  function update(){
    if(contextActor!==store.principal?.userId){contextActor=store.principal?.userId;scrolls.clear();context.hidden=true;}
    const changed=page!==null&&page!==getPage();page=getPage();document.body.dataset.room=page;
    q('#account-avatar').textContent=(store.users.find(user=>user.id===store.principal?.userId)?.name||store.principal?.username||'S').slice(0,1);
    if(notice!==q('#mode-note').textContent)notice=q('#mode-note').textContent;
    syncContext();syncNavigation();updateMobileAction();control.update();renderMe();updateIndicator(changed);
    if(page==='work')q('#page-title').classList.add('work-project-title');else q('#page-title').classList.remove('work-project-title');
  }
  function syncStatus(state,time){q('#sync-label').textContent=state==='syncing'?'正在同步':state==='failed'?'同步失败，保留已确认状态':'已同步 '+new Date(time||Date.now()).toLocaleTimeString('zh-CN',{hour12:false});}
  const clearGhosts=()=>{roomAnimation?.cancel();headingAnimation?.cancel();ghost?.remove();for(const layer of document.querySelectorAll('.object-transition-layer'))layer.remove();};
  addEventListener('resize',()=>{clearGhosts();syncNavigation();updateMobileAction();control.update();updateIndicator();});
  store.onAuthChange(()=>{clearGhosts();control.close(true);account.open=false;scrolls.clear();context.hidden=true;});
  requestAnimationFrame(()=>{const initial=q('[data-page]:not([hidden])');initial?.animate([{opacity:0},{opacity:1}],{duration:reduced()?150:220,easing:'linear'});});
  return {update,route,syncStatus,control};
}
