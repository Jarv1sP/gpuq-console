import {copyHelp} from './copy-help-ui.js';
// The approved split outline gives both Lambda glyphs one ignition path.
const wordmark="<svg class=\"wordmark auth-r5-wordmark\" viewBox=\"0 0 9753 711\" role=\"img\" aria-label=\"平台字标\"><path class=\"r5-mark-letter\" d=\"M432 711Q354 711 286.0 701.5Q218 692 167.0 667.5Q116 643 87.5 599.0Q59 555 59 486Q59 484 59.0 481.0Q59 478 60 476H210Q209 480 208.5 485.5Q208 491 208 498Q208 529 235.0 548.5Q262 568 312.0 577.0Q362 586 429 586Q458 586 487.5 583.5Q517 581 544.0 576.0Q571 571 592.5 562.0Q614 553 626.5 539.5Q639 526 639 508Q639 482 615.5 466.5Q592 451 552.0 441.0Q512 431 462.0 424.0Q412 417 358.5 408.5Q305 400 255.0 385.5Q205 371 165.0 348.0Q125 325 101.5 288.5Q78 252 78 199Q78 151 101.0 114.0Q124 77 169.0 51.5Q214 26 279.5 13.0Q345 0 430 0Q516 0 580.0 14.0Q644 28 686.0 54.0Q728 80 748.5 116.5Q769 153 769 198V214H621V201Q621 179 597.0 162.0Q573 145 532.0 135.0Q491 125 439 125Q367 125 322.0 134.0Q277 143 256.0 158.5Q235 174 235 193Q235 216 258.5 230.0Q282 244 322.0 252.5Q362 261 412.0 268.0Q462 275 515.5 284.0Q569 293 619.0 307.0Q669 321 709.0 344.5Q749 368 772.5 403.5Q796 439 796 491Q796 571 750.0 619.5Q704 668 622.0 689.5Q540 711 432 711ZM1561 699V146H1256V12H2018V146H1713V699ZM3809 699V12H4353Q4426 12 4472.5 41.5Q4519 71 4542.0 119.5Q4565 168 4565 227Q4565 288 4533.5 341.5Q4502 395 4436 425L4582 699H4411L4285 454H3961V699ZM3961 328H4311Q4358 328 4383.5 300.5Q4409 273 4409 230Q4409 201 4398.0 180.5Q4387 160 4365.0 149.5Q4343 139 4311 139H3961ZM5495 711Q5287 711 5183.0 623.0Q5079 535 5079 356Q5079 239 5132.0 159.5Q5185 80 5285.5 40.0Q5386 0 5526 0Q5617 0 5692.0 15.5Q5767 31 5821.5 62.5Q5876 94 5905.5 142.0Q5935 190 5935 255H5787Q5787 219 5766.0 194.0Q5745 169 5709.0 154.5Q5673 140 5627.5 133.5Q5582 127 5532 127Q5468 127 5413.5 139.5Q5359 152 5319.0 178.5Q5279 205 5257.0 246.0Q5235 287 5235 343V367Q5235 445 5269.0 492.5Q5303 540 5365.5 562.0Q5428 584 5513 584Q5607 584 5667.5 567.0Q5728 550 5757.5 518.0Q5787 486 5787 443V435H5509V315H5936V699H5842L5826 609Q5789 645 5737.5 667.5Q5686 690 5624.5 700.5Q5563 711 5495 711ZM8024 699V146H7719V12H8481V146H8176V699ZM8984 699V12H9679V139H9136V286H9619V413H9136V572H9687V699Z\"></path><path class=\"auth-lambda\" d=\"M2448 699L2792 12L2964 12L3308 699L3141 699L2873 150L2604 699ZM6429 699L6773 12L6945 12L7289 699L7122 699L6854 150L6585 699Z\"></path></svg>";

const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
// Original, approved R5Login line drawing. Only the public machine directory
// chooses its bays; this illustration never reads monitoring or user records.
function chassis(machine,index){
  const cards=Number.isSafeInteger(machine.cards)&&machine.cards>0?machine.cards:0;
  const step=112/Math.max(cards,1),width=Math.max(2,step-3);
  const vents=Array.from({length:45},(_,n)=>'<circle cx="'+(32+n%15*8)+'" cy="'+(72+Math.floor(n/15)*7)+'" r="1"/>').join('');
  const bays=Array.from({length:cards},(_,n)=>{const x=30+n*step;return '<g class="auth-bay"><rect class="bay-face" x="'+x+'" y="112" width="'+width+'" height="171" rx="1"/><path class="bay-line" d="M'+(x+2)+' 117h'+(width-4)+'M'+(x+2)+' 278h'+(width-4)+'"/><circle class="bay-pin" cx="'+(x+width/2)+'" cy="266" r="1.2"/></g>';}).join('');
  const screws=[[16,22],[16,320],[160,22],[160,320]].map(([x,y])=>'<g><circle class="screw" cx="'+x+'" cy="'+y+'" r="2.4"/><path d="M'+(x-1.1)+' '+y+'h2.2"/></g>').join('');
  return '<figure data-auth-machine="'+escape(machine.id)+'"><svg class="auth-chassis" viewBox="0 0 176 354" role="img" aria-label="'+escape(machine.id)+' 静态服务器外形"><path class="outer-depth" d="M12 8h152l6 6v318l-6 8H12l-6-8V14Z"/><rect class="bezel" x="10.5" y="10.5" width="155" height="323" rx="3"/><path class="edge-light" d="M14 11h147M11 16v309"/><rect class="face" x="23.5" y="22.5" width="129" height="299" rx="1"/><path class="panel-seam" d="M24 53.5h128M24 100.5h128M24 296.5h128"/><rect class="handle" x=".5" y="135.5" width="8" height="76" rx="2"/><rect class="handle" x="166.5" y="135.5" width="8" height="76" rx="2"/><path class="engraving" d="M32 37h22m3 0h8"/><text class="hardware-id" x="143" y="41" text-anchor="end">'+String(index+1).padStart(2,'0')+'</text><g class="perforation">'+vents+'</g>'+bays+'<rect class="port" x="33.5" y="306.5" width="14" height="6"/><rect class="port" x="53.5" y="306.5" width="14" height="6"/><path class="port" d="M81 307h30m-30 4h30"/>'+screws+'<path class="foot" d="M17 340v6h21v-6m100 0v6h21v-6"/></svg><figcaption>'+copyHelp('服务器名称',machine.id,'',{triggerText:machine.id,triggerLabel:'查看完整服务器名称 '+machine.id})+'</figcaption></figure>';
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
