import {registerAdminSection} from './admin-ui.js';
import {mountCreateUser} from './admin-create-user-ui.js';

// Move the original controls, retaining their DOM identity and handlers.
// The admin frame supplies the confirmed identity and aborts before unmount.
export const membersRoute=route=>String(route??'').replace(/^#/,'')==='users'?'#admin/members':route;
export function membersAdminUI(store,{getPage,render,unmount=()=>{},canCreate=()=>true,onCreated=()=>{},toast=()=>{}}){
  const parking=document.querySelector('#members-parking'),root=document.querySelector('#page-users');
  const dialogs=['password-dialog','invites-dialog','preview-dialog','confirm-dialog'].map(id=>document.getElementById(id));
  let context=null,createForm=null;
  const active=()=>!!context&&!context.signal.aborted&&!store.authPending&&getPage()==='admin'&&
    store.principal?.role==='admin'&&store.principal.userId===context.principal.userId;
  const unregister=registerAdminSection({id:'members',title:'成员与额度',order:30,
    mount(el,ctx){
      context=ctx;root.hidden=false;el.append(root,...dialogs);
      createForm=mountCreateUser(store,root,ctx,{active,canCreate,onCreated,toast});
      ctx.subscribe(()=>{if(active()){root.hidden=false;render();}});
    },
    unmount(){
      context=null;
      createForm?.dispose();createForm=null;
      for(const dialog of dialogs){dialog.close();dialog.querySelector('form')?.reset();}
      root.hidden=true;parking.append(root,...dialogs);
      document.querySelector('#editor').replaceChildren();document.querySelector('#user-list').replaceChildren();
      document.querySelector('#invites-content').replaceChildren();document.querySelector('#invites-error').textContent='';
      document.querySelector('#password-account').textContent='';document.querySelector('#password-error').textContent='';
      document.querySelector('#preview-content').replaceChildren();document.querySelector('#confirm-message').textContent='';document.querySelector('#confirm-title').textContent='';
      unmount();
    },
  });
  return {active,capture:()=>context,current:stamp=>!!stamp&&stamp===context&&active(),
    updateCreate:()=>createForm?.render(),
    owns:node=>root.contains(node)||dialogs.some(dialog=>dialog.contains(node)),dispose:unregister};
}
