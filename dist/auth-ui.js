import {copyHelp} from './copy-help-ui.js';
const wordmark="<svg class=\"auth-r5-wordmark\" viewBox=\"0 0 9661 711\" role=\"img\" aria-label=\"STARBASE\"><path class=\"r5-mark-letter\" d=\"M373 711Q295 711 227 702Q159 692 108 668Q57 643 28 599Q0 555 0 486Q0 484 0 481Q0 478 1 476L151 476Q150 480 150 486Q149 491 149 498Q149 529 176 548Q203 568 253 577Q303 586 370 586Q399 586 428 584Q458 581 485 576Q512 571 534 562Q555 553 568 540Q580 526 580 508Q580 482 556 466Q533 451 493 441Q453 431 403 424Q353 417 300 408Q246 400 196 386Q146 371 106 348Q66 325 42 288Q19 252 19 199Q19 151 42 114Q65 77 110 52Q155 26 220 13Q286 0 371 0Q457 0 521 14Q585 28 627 54Q669 80 690 116Q710 153 710 198L710 214L562 214L562 201Q562 179 538 162Q514 145 473 135Q432 125 380 125Q308 125 263 134Q218 143 197 158Q176 174 176 193Q176 216 200 230Q223 244 263 252Q303 261 353 268Q403 275 456 284Q510 293 560 307Q610 321 650 344Q690 368 714 404Q737 439 737 491Q737 571 691 620Q645 668 563 690Q481 711 373 711ZM1542 699L1542 146L1237 146L1237 12L1999 12L1999 146L1694 146L1694 699ZM3735 699L3735 12L4279 12Q4352 12 4398 42Q4445 71 4468 120Q4491 168 4491 227Q4491 288 4460 342Q4428 395 4362 425L4508 699L4337 699L4211 454L3887 454L3887 699ZM3887 328L4237 328Q4284 328 4310 300Q4335 273 4335 230Q4335 201 4324 180Q4313 160 4291 150Q4269 139 4237 139L3887 139ZM5075 699L5075 12L5606 12Q5661 12 5704 34Q5748 55 5773 93Q5798 131 5798 182Q5798 221 5783 253Q5768 285 5742 306Q5717 328 5685 339L5685 343Q5723 351 5753 374Q5783 396 5800 430Q5817 465 5817 510Q5817 574 5788 616Q5760 658 5712 678Q5665 699 5606 699ZM5227 572L5575 572Q5613 572 5637 553Q5661 534 5661 493Q5661 469 5651 450Q5641 432 5621 422Q5601 412 5569 412L5227 412ZM5227 288L5557 288Q5585 288 5604 278Q5623 269 5633 252Q5643 235 5643 215Q5643 177 5621 158Q5599 139 5563 139L5227 139ZM8053 711Q7975 711 7907 702Q7839 692 7788 668Q7737 643 7708 599Q7680 555 7680 486Q7680 484 7680 481Q7680 478 7681 476L7831 476Q7830 480 7830 486Q7829 491 7829 498Q7829 529 7856 548Q7883 568 7933 577Q7983 586 8050 586Q8079 586 8108 584Q8138 581 8165 576Q8192 571 8214 562Q8235 553 8248 540Q8260 526 8260 508Q8260 482 8236 466Q8213 451 8173 441Q8133 431 8083 424Q8033 417 7980 408Q7926 400 7876 386Q7826 371 7786 348Q7746 325 7722 288Q7699 252 7699 199Q7699 151 7722 114Q7745 77 7790 52Q7835 26 7900 13Q7966 0 8051 0Q8137 0 8201 14Q8265 28 8307 54Q8349 80 8370 116Q8390 153 8390 198L8390 214L8242 214L8242 201Q8242 179 8218 162Q8194 145 8153 135Q8112 125 8060 125Q7988 125 7943 134Q7898 143 7877 158Q7856 174 7856 193Q7856 216 7880 230Q7903 244 7943 252Q7983 261 8033 268Q8083 275 8136 284Q8190 293 8240 307Q8290 321 8330 344Q8370 368 8394 404Q8417 439 8417 491Q8417 571 8371 620Q8325 668 8243 690Q8161 711 8053 711ZM8958 699L8958 12L9653 12L9653 139L9110 139L9110 286L9593 286L9593 413L9110 413L9110 572L9661 572L9661 699Z\"></path><path class=\"auth-lambda\" d=\"M2334 699L2678 12L2850 12L3194 699L3027 699L2822 275Q2817 264 2808 242Q2798 221 2788 198Q2779 176 2772 160Q2764 143 2763 142L2755 142Q2746 162 2734 188Q2723 214 2712 238Q2702 262 2695 276L2490 699Z\"></path><path class=\"auth-lambda\" d=\"M6317 699L6661 12L6833 12L7177 699L7010 699L6805 275Q6800 264 6790 242Q6781 221 6772 198Q6762 176 6754 160Q6747 143 6746 142L6738 142Q6729 162 6718 188Q6706 214 6696 238Q6685 262 6678 276L6473 699Z\"></path></svg>";

const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
// Original, approved R5Login line drawing. Only the public machine directory
// chooses its bays; this illustration never reads monitoring or user records.
function chassis(machine,index){
  const cards=Number.isSafeInteger(machine.cards)&&machine.cards>0?machine.cards:0;
  const step=112/Math.max(cards,1),width=Math.max(2,step-3);
  const vents=Array.from({length:45},(_,n)=>'<circle cx="'+(32+n%15*8)+'" cy="'+(72+Math.floor(n/15)*7)+'" r="1"/>').join('');
  const bays=Array.from({length:cards},(_,n)=>{const x=30+n*step;return '<g class="auth-bay"><rect class="bay-face" x="'+x+'" y="112" width="'+width+'" height="171" rx="1"/><path class="bay-line" d="M'+(x+2)+' 117h'+(width-4)+'M'+(x+2)+' 278h'+(width-4)+'"/><circle class="bay-pin" cx="'+(x+width/2)+'" cy="266" r="1.2"/></g>';}).join('');
  const screws=[[16,22],[16,320],[160,22],[160,320]].map(([x,y])=>'<g><circle class="screw" cx="'+x+'" cy="'+y+'" r="2.4"/><path d="M'+(x-1.1)+' '+y+'h2.2"/></g>').join('');
  return '<figure data-auth-machine="'+escape(machine.id)+'"><svg class="auth-chassis" viewBox="0 0 176 354" role="img" aria-label="'+escape(machine.id)+' 静态服务器外形"><path class="outer-depth" d="M12 8h152l6 6v318l-6 8H12l-6-8V14Z"/><rect class="bezel" x="10.5" y="10.5" width="155" height="323" rx="3"/><path class="edge-light" d="M14 11h147M11 16v309"/><rect class="face" x="23.5" y="22.5" width="129" height="299" rx="1"/><path class="panel-seam" d="M24 53.5h128M24 100.5h128M24 296.5h128"/><rect class="handle" x=".5" y="135.5" width="8" height="76" rx="2"/><rect class="handle" x="166.5" y="135.5" width="8" height="76" rx="2"/><path class="engraving" d="M32 37h22m3 0h8"/><text class="hardware-id" x="143" y="41" text-anchor="end">'+String(index+1).padStart(2,'0')+'</text><g class="perforation">'+vents+'</g>'+bays+'<rect class="port" x="33.5" y="306.5" width="14" height="6"/><rect class="port" x="53.5" y="306.5" width="14" height="6"/><path class="port" d="M81 307h30m-30 4h30"/>'+screws+'<path class="foot" d="M17 340v6h21v-6m100 0v6h21v-6"/></svg><figcaption>'+escape(machine.id)+'</figcaption></figure>';
}
export function installAuthentication(machines){
  document.querySelector('[data-copy-password]').innerHTML=copyHelp('重置密码','旧密码不能查看，只能设置新密码。重置后，原密码和已登录会话失效。','/guide/start');
  document.querySelector('[data-copy-profile]').innerHTML=copyHelp('任务署名','同服务器的授权成员可见，登录用户名和权限不变。新任务保存提交时的姓名，旧任务没有署名记录时使用现有姓名。','/guide/results');
  const login=document.querySelector('#login-dialog'),register=document.querySelector('#register-dialog'),form=login.querySelector('form');
  login.classList.add('r5-login');
  login.querySelector('.auth-mast>.wordmark').replaceWith(Object.assign(document.createElement('span'),{className:'auth-platform',textContent:'实验室计算平台'}));
  form.querySelector('.auth-hero-mark').remove();
  const layout=document.createElement('div');layout.className='auth-r5-layout';
  const identity=document.createElement('section');identity.className='auth-login-identity';identity.innerHTML=wordmark+'<div class="auth-login-fleet">'+machines.map(chassis).join('')+'</div>';
  layout.append(identity,form);login.querySelector('.auth-mast').after(layout);
  form.querySelector('.eyebrow').remove();
  const loginIntro=form.querySelector(':scope>.muted');loginIntro.remove();
  const signup=form.querySelector('.auth-footer>span');signup.textContent='没有账号？';
  register.querySelector('.eyebrow').remove();register.querySelector('form>.muted').remove();
  const topics=[
    ['invite','注册码','注册后额度为 0，需要管理员授权。注册码只用于注册，不是登录密码。'],
    ['username','用户名','2–24 位，以汉字或小写字母开头。可包含数字、下划线和短横线。'],
    ['signup-name','显示名','未填写时使用用户名。同服务器的已授权成员可以看到你的任务署名。'],
  ];
  for(const [name,label,text] of topics){const input=register.querySelector('[name="'+name+'"]'),old=input.closest('label'),field=document.createElement('div'),caption=document.createElement('label');field.className='field';input.id||='register-'+name;caption.htmlFor=input.id;caption.textContent=label;const heading=document.createElement('div');heading.className='field-caption';heading.append(caption);heading.insertAdjacentHTML('beforeend',copyHelp(label,text,'/guide/start'));field.append(heading,input);old.replaceWith(field);}
  let ignited=false;
  const key='starbase-r5-wordmark-ignited',reduce=matchMedia('(prefers-reduced-motion:reduce)');
  try{ignited=sessionStorage.getItem(key)==='1';}catch{}
  let finishTimer;
  const finish=()=>{clearTimeout(finishTimer);login.classList.remove('wordmark-ignition');};
  function ignite(){
    if(!login.open){finish();return;}if(ignited||document.hidden)return;
    ignited=true;try{sessionStorage.setItem(key,'1');}catch{}
    if(reduce.matches)return;
    login.classList.add('wordmark-ignition');finishTimer=setTimeout(finish,650);
  }
  new MutationObserver(ignite).observe(login,{attributes:true,attributeFilter:['open']});
  document.addEventListener('visibilitychange',ignite);
  reduce.addEventListener('change',event=>{if(event.matches)finish();});
  ignite();
}
