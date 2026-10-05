// Short, on-demand explanations. They never send an application operation.
let serial=0;
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function copyHelp(label,text,chapter='',{triggerText=null,triggerLabel=label}={}){
  const id='copy-help-'+(++serial),href=/^\/guide(?:\/[a-z-]+)?(?:#section-\d+)?$/.test(chapter)?chapter:'';
  const named=triggerText!==null,trigger=named?`<span>${escape(triggerText)}</span>`:'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4"/><circle cx="8" cy="5" r=".7" fill="currentColor" stroke="none"/></svg>';
  return `<span class="copy-help${named?' copy-help-name':''}"><button type="button" class="copy-help-button${named?' copy-help-name-button':''}" data-copy-help aria-controls="${id}" aria-expanded="false" aria-label="${escape(triggerLabel)}">${trigger}</button><span class="copy-help-popup" id="${id}" popover="auto" role="note"><strong>${escape(label)}</strong><span>${escape(text)}</span>${href?`<a class="copy-help-guide" href="${escape(href)}" target="_blank" rel="noopener">了解更多 ↗</a>`:''}</span></span>`;
}

if(typeof document!=='undefined'){
  let active=null,hideTimer=null;
  const buttonFor=popup=>document.querySelector('[data-copy-help][aria-controls="'+popup.id+'"]');
  function close(){clearTimeout(hideTimer);if(!active)return;const popup=active;active=null;try{if(popup.showPopover&&popup.matches(':popover-open'))popup.hidePopover();}catch{}popup.classList.remove('is-open');delete popup.dataset.pinned;buttonFor(popup)?.setAttribute('aria-expanded','false');}
  function place(popup,button){const width=Math.min(320,innerWidth-32),r=button.getBoundingClientRect();popup.style.width=width+'px';popup.style.left=Math.max(16,Math.min(innerWidth-width-16,r.right-width))+'px';const height=popup.getBoundingClientRect().height;popup.style.top=Math.max(16,Math.min(innerHeight-height-16,r.bottom+8))+'px';}
  function show(button,pinned=false){
    clearTimeout(hideTimer);const popup=document.getElementById(button.getAttribute('aria-controls'));if(!popup)return;
    if(active!==popup){close();active=popup;popup.classList.add('is-open');button.setAttribute('aria-expanded','true');}
    if(popup.showPopover&&!popup.matches(':popover-open'))popup.showPopover({source:button});
    if(pinned)popup.dataset.pinned='true';place(popup,button);
  }
  document.addEventListener('click',event=>{const button=event.target.closest?.('[data-copy-help]');if(!button)return;const popup=document.getElementById(button.getAttribute('aria-controls'));if(active===popup&&popup.dataset.pinned)close();else show(button,true);});
  document.addEventListener('pointerover',event=>{if(event.pointerType!=='mouse')return;const button=event.target.closest?.('[data-copy-help]'),popup=event.target.closest?.('.copy-help-popup');if(button)show(button);else if(popup===active)clearTimeout(hideTimer);});
  document.addEventListener('pointerout',event=>{if(!active||active.dataset.pinned||event.pointerType!=='mouse')return;const next=event.relatedTarget;if(active.contains(next)||buttonFor(active)?.contains(next))return;hideTimer=setTimeout(close,140);});
  document.addEventListener('toggle',event=>{if(event.target===active&&event.newState==='closed')close();},{capture:true});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&active&&!active.showPopover)close();});
  addEventListener('resize',()=>{if(active){const button=buttonFor(active);if(button)place(active,button);else close();}});
  const visibility=new MutationObserver(()=>{if(!active)return;const owner=active.closest('[data-page]'),dialog=active.closest('dialog'),button=buttonFor(active);if(!active.isConnected||!button?.getClientRects().length||owner?.hidden||dialog&&!dialog.open)close();});
  visibility.observe(document.body,{subtree:true,attributes:true,attributeFilter:['hidden','open'],childList:true});
}
