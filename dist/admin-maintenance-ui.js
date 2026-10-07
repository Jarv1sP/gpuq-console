import {registerAdminSection} from './admin-ui.js';
import {operationalMaintenanceUI} from './maintenance-ui.js';
import {hostDiagnosticsUI} from './host-diagnostics-ui.js';
import {serverIdHTML} from './workbench-ui.js';
import {sessionStatus} from './control-ui.js';

export function maintenanceAdminUI(store,experience,{getPage,toast,refresh}){
  let context=null,settings=null,sessions=[];
  const diagnostics=hostDiagnosticsUI(store,{toast}),parking=document.querySelector('#maintenance-root-parking');
  const active=ctx=>!!ctx&&ctx===context&&!ctx.signal.aborted&&!store.authPending&&getPage()==='admin'&&
    store.principal?.role==='admin'&&store.principal.userId===ctx.principal.userId;
  return registerAdminSection({id:'maintenance',title:'维护',order:40,
    mount(el,ctx){
      context=ctx;el.className='admin-maintenance';
      settings=document.createElement('div');settings.id='admin-maintenance-settings';el.append(settings);
      const renderSettings=operationalMaintenanceUI(store,toast,refresh,{host:settings,management:true,active:()=>active(ctx)});
      experience.mountAdmin(el,ctx);
      const rootPanel=parking.querySelector('#host-maintenance');rootPanel.hidden=false;el.append(rootPanel);
      const sessionPanel=document.createElement('section');sessionPanel.className='maintenance-root-sessions';sessionPanel.innerHTML='<h3>我的 ROOT 会话</h3><div data-maintenance-root-sessions></div>';el.append(sessionPanel);
      diagnostics.mount(el,ctx);
      function render(){
        if(!active(ctx))return;renderSettings();
        const machines=store.data?.machines||[],selector=rootPanel.querySelector('[data-maintenance-root-machine]'),before=selector.value;
        if(selector.dataset.rows!==JSON.stringify(machines.map(row=>row.id))){selector.dataset.rows=JSON.stringify(machines.map(row=>row.id));selector.replaceChildren(...machines.map(machine=>{const option=document.createElement('option');option.value=machine.id;option.textContent=machine.id;return option;}));if(machines.some(row=>row.id===before))selector.value=before;}
        selector.title=selector.value;rootPanel.hidden=false;
        for(const button of rootPanel.querySelectorAll('button'))button.disabled=!selector.value||!store.production||store.data?.executionEnabled!==true;
        const own=sessions.filter(row=>row.userId===ctx.principal.userId&&row.hostAdmin);sessionPanel.hidden=!own.length;
        sessionPanel.querySelector('[data-maintenance-root-sessions]').replaceChildren(...own.map(row=>{const button=document.createElement('button');button.className='button quiet';button.type='button';button.innerHTML=serverIdHTML(row.machine)+'<span></span>';button.lastElementChild.textContent=sessionStatus(row)+' · '+row.id.slice(0,8);button.title=row.id;button.onclick=()=>{if(active(ctx))document.dispatchEvent(new CustomEvent('gpuq-terminal-reveal',{detail:{id:row.id,userId:ctx.principal.userId}}));};return button;}));
      }
      rootPanel.addEventListener('click',event=>{const button=event.target.closest('#terminal-root-open,#terminal-root-reconnect');if(!button||button.disabled||!active(ctx))return;event.stopPropagation();document.dispatchEvent(new CustomEvent('gpuq-maintenance-root',{detail:{userId:ctx.principal.userId,machine:rootPanel.querySelector('select').value,mode:button.id.endsWith('reconnect')?'reconnect':'new'}}));},{signal:ctx.signal});
      el.addEventListener('click',event=>{if(event.target.closest('[data-maintenance-settings]')&&active(ctx))settings.querySelector('dialog')?.showModal();},{signal:ctx.signal});
      document.addEventListener('gpuq-maintenance-host',event=>{if(!active(ctx)||event.detail?.userId!==ctx.principal.userId)return;diagnostics.select(event.detail.machine);document.querySelector('#admin-host-diagnostics')?.scrollIntoView({block:'start',behavior:'instant'});},{signal:ctx.signal});
      document.addEventListener('gpuq-terminal-state',event=>{if(active(ctx)){sessions=event.detail?.sessions||[];render();}},{signal:ctx.signal});
      ctx.subscribe(render);document.dispatchEvent(new Event('gpuq-terminal-state-request'));
    },
    unmount(){
      const previous=context;context=null;diagnostics.unmount();experience.unmountAdmin();
      const rootPanel=document.querySelector('#host-maintenance');if(rootPanel){rootPanel.hidden=true;rootPanel.open=false;parking.append(rootPanel);}
      settings?.querySelector('dialog')?.close();settings?.replaceChildren();settings=null;sessions=[];
      if(previous)document.dispatchEvent(new CustomEvent('gpuq-maintenance-retire',{detail:{userId:previous.principal.userId}}));
    },
  });
}
