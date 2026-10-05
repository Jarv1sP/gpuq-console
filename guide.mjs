import {readFile} from 'node:fs/promises';

export const chapters=[
  {id:'start',title:'首次使用',description:'注册账号，获得额度，连上你的工作空间。'},
  {id:'development',title:'项目开发',description:'上传代码、安装依赖，准备可重复运行的版本。'},
  {id:'training',title:'提交训练',description:'发布后运行，选择多卡、弹性或共享方式。'},
  {id:'data',title:'数据集',description:'上传、准备和使用数据；大文件也有合适的方式。'},
  {id:'results',title:'日志与结果',description:'查询进度，设置通知与留言，下载结果。'},
  {id:'queue',title:'排队与协作',description:'分清等级、抢占、保存让位与自动恢复。'},
  {id:'troubleshooting',title:'常见问题',description:'手动同步、排查故障，反馈系统依赖问题。'},
];
const aliases={'/guide/':'/guide','/guide/user':'/guide/start','/guide/projects':'/guide/development','/guide/datasets':'/guide/data','/guide/community':'/guide/queue','/guide/terminal-sessions':'/guide/development','/guide/diagnostics':'/guide/results','/guide/ray-resources':'/guide/troubleshooting','/guide/project-network':'/guide/troubleshooting'};
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// The guide supports a deliberately small Markdown subset. Raw HTML is always
// text; links never become scripts or arbitrary local-file URLs.
export function inline(text){
  const pattern=/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let result='',last=0;
  for(const match of text.matchAll(pattern)){
    result+=escape(text.slice(last,match.index));last=match.index+match[0].length;
    if(match[1])result+=`<code>${escape(match[1])}</code>`;
    else if(match[2])result+=`<strong>${escape(match[2])}</strong>`;
    else{
      const href=match[4],safe=/^https?:\/\//.test(href)||/^\/guide(?:\/[a-z-]+)?(?:#[a-z-]+)?$/.test(href)||/^#[a-z-]+$/.test(href);
      result+=safe?`<a href="${escape(href)}"${/^https?:/.test(href)?' rel="noreferrer"':''}>${escape(match[3])}</a>`:escape(match[3]);
    }
  }
  return result+escape(text.slice(last));
}
export function renderMarkdown(source,{headings=[]}={}){
  const lines=source.replaceAll('\r','').split('\n');let output='',paragraph=[],list=null,section=0;
  const flush=()=>{if(paragraph.length){output+=`<p>${inline(paragraph.join(' '))}</p>`;paragraph=[];}if(list){output+=`</${list}>`;list=null;}};
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line.startsWith('```')){
      const where=/^```[a-z]+ (local|project|data)\s*$/.exec(line)?.[1],location={local:'本机终端',project:'项目开发终端',data:'数据终端'}[where]||'命令示例';
      flush();const code=[];while(++i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i]);
      output+=`<div class="guide-code"><div class="guide-code-bar"><span>${location}</span><button type="button" class="copy-code" hidden aria-label="复制这段命令">复制</button></div><pre tabindex="0"><code>${escape(code.join('\n'))}</code></pre></div>`;continue;
    }
    if(!line.trim()){flush();continue;}
    if(line.startsWith('### ')){flush();const title=line.slice(4),id='section-'+(++section);headings.push({id,title});output+=`<h2 id="${id}" tabindex="-1">${inline(title)}</h2>`;continue;}
    const item=/^(?:([-*]) |(\d+)\. )(.*)$/.exec(line);
    if(item){const type=item[1]?'ul':'ol';if(paragraph.length||list&&list!==type)flush();if(!list){output+=`<${type}>`;list=type;}output+=`<li>${inline(item[3])}</li>`;continue;}
    if(list)flush();paragraph.push(line);
  }
  flush();return output;
}
export function parseGuide(source){
  const sections=new Map();let id=null,body=[];
  const flush=()=>{if(id){if(sections.has(id))throw Error('Duplicate guide chapter');sections.set(id,body.join('\n').trim());}};
  for(const line of source.split('\n')){
    const match=/^## .+ \{#([a-z-]+)\}\s*$/.exec(line);
    if(match){flush();id=match[1];body=[];}else if(id)body.push(line);
  }
  flush();if(sections.size!==chapters.length||chapters.some(chapter=>!sections.get(chapter.id)))throw Error('Incomplete user guide');
  return sections;
}
export function guideTarget(path){
  if(Object.hasOwn(aliases,path))return {redirect:aliases[path]};
  if(path==='/guide')return {chapter:null};
  const chapter=chapters.find(item=>path==='/guide/'+item.id);
  return chapter?{chapter}:null;
}
const guideWordmark="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 9753 711'><path fill='currentColor' d='M432 711Q354 711 286.0 701.5Q218 692 167.0 667.5Q116 643 87.5 599.0Q59 555 59 486Q59 484 59.0 481.0Q59 478 60 476H210Q209 480 208.5 485.5Q208 491 208 498Q208 529 235.0 548.5Q262 568 312.0 577.0Q362 586 429 586Q458 586 487.5 583.5Q517 581 544.0 576.0Q571 571 592.5 562.0Q614 553 626.5 539.5Q639 526 639 508Q639 482 615.5 466.5Q592 451 552.0 441.0Q512 431 462.0 424.0Q412 417 358.5 408.5Q305 400 255.0 385.5Q205 371 165.0 348.0Q125 325 101.5 288.5Q78 252 78 199Q78 151 101.0 114.0Q124 77 169.0 51.5Q214 26 279.5 13.0Q345 0 430 0Q516 0 580.0 14.0Q644 28 686.0 54.0Q728 80 748.5 116.5Q769 153 769 198V214H621V201Q621 179 597.0 162.0Q573 145 532.0 135.0Q491 125 439 125Q367 125 322.0 134.0Q277 143 256.0 158.5Q235 174 235 193Q235 216 258.5 230.0Q282 244 322.0 252.5Q362 261 412.0 268.0Q462 275 515.5 284.0Q569 293 619.0 307.0Q669 321 709.0 344.5Q749 368 772.5 403.5Q796 439 796 491Q796 571 750.0 619.5Q704 668 622.0 689.5Q540 711 432 711ZM1561 699V146H1256V12H2018V146H1713V699ZM2448 699L2792 12L2964 12L3308 699L3141 699L2873 150L2604 699ZM3809 699V12H4353Q4426 12 4472.5 41.5Q4519 71 4542.0 119.5Q4565 168 4565 227Q4565 288 4533.5 341.5Q4502 395 4436 425L4582 699H4411L4285 454H3961V699ZM3961 328H4311Q4358 328 4383.5 300.5Q4409 273 4409 230Q4409 201 4398.0 180.5Q4387 160 4365.0 149.5Q4343 139 4311 139H3961ZM5495 711Q5287 711 5183.0 623.0Q5079 535 5079 356Q5079 239 5132.0 159.5Q5185 80 5285.5 40.0Q5386 0 5526 0Q5617 0 5692.0 15.5Q5767 31 5821.5 62.5Q5876 94 5905.5 142.0Q5935 190 5935 255H5787Q5787 219 5766.0 194.0Q5745 169 5709.0 154.5Q5673 140 5627.5 133.5Q5582 127 5532 127Q5468 127 5413.5 139.5Q5359 152 5319.0 178.5Q5279 205 5257.0 246.0Q5235 287 5235 343V367Q5235 445 5269.0 492.5Q5303 540 5365.5 562.0Q5428 584 5513 584Q5607 584 5667.5 567.0Q5728 550 5757.5 518.0Q5787 486 5787 443V435H5509V315H5936V699H5842L5826 609Q5789 645 5737.5 667.5Q5686 690 5624.5 700.5Q5563 711 5495 711ZM6429 699L6773 12L6945 12L7289 699L7122 699L6854 150L6585 699ZM8024 699V146H7719V12H8481V146H8176V699ZM8984 699V12H9679V139H9136V286H9619V413H9136V572H9687V699Z'/></svg>";
const guideMark="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><path fill='currentColor' d='M10.41 71.20 L42.06 8.00 L57.88 8.00 L89.53 71.20 L74.16 71.20 L49.51 20.70 L24.76 71.20 Z M3 95 Q50 66 97 95 Q50 75 3 95 Z'/></svg>";
const guideFavicon="data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2040%2040%27%3E%3Crect%20width%3D%2740%27%20height%3D%2740%27%20rx%3D%279%27%20fill%3D%27%230A0B0D%27%2F%3E%3Cg%20transform%3D%27translate%287%207%29%20scale%28.26%29%27%3E%3Cpath%20fill%3D%27%23F2F2EF%27%20d%3D%27M10.41%2071.20%20L42.06%208.00%20L57.88%208.00%20L89.53%2071.20%20L74.16%2071.20%20L49.51%2020.70%20L24.76%2071.20%20Z%20M3%2095%20Q50%2066%2097%2095%20Q50%2075%203%2095%20Z%27%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E";
export async function guidePage(chapter,origin){
  const sections=parseGuide((await readFile(new URL('./docs/USER_GUIDE.md',import.meta.url),'utf8')).replaceAll('https://gpu.example.com',origin));
  const nav=chapters.map((item,index)=>`<a href="/guide/${item.id}"${chapter?.id===item.id?' aria-current="page"':''}><span class="guide-number">${String(index+1).padStart(2,'0')}</span><span>${item.title}</span><span class="guide-arrow" aria-hidden="true">↗</span></a>`).join('');
  const index=chapter?chapters.findIndex(item=>item.id===chapter.id):-1;
  const sibling=(item,label)=>item?`<a href="/guide/${item.id}"><small>${label}</small><span>${item.title} <span aria-hidden="true">→</span></span></a>`:'<span></span>';
  const headings=[],prose=chapter?renderMarkdown(sections.get(chapter.id),{headings}):'';
  const toc=chapter?`<details class="guide-toc"><summary>本章内容</summary><nav aria-label="本章内容">${headings.map(item=>`<a href="#${item.id}">${escape(item.title)}</a>`).join('')}</nav></details>`:'';
  const content=chapter?`<div class="guide-layout"><aside class="guide-sidebar"><a class="guide-overview" href="/guide">全部内容</a><nav aria-label="指南章节">${nav}</nav></aside><article class="guide-article"><header><p class="guide-eyebrow">使用指南 / ${String(index+1).padStart(2,'0')}</p><h1>${chapter.title}</h1><p class="guide-lead">${chapter.description}</p></header>${toc}<div class="guide-prose">${prose}</div><nav class="guide-pagination" aria-label="相邻章节">${sibling(chapters[index-1],'上一章')}${sibling(chapters[index+1],'下一章')}</nav></article></div>`:
    `<section class="guide-hero"><div><p class="guide-eyebrow">STARGATE / 使用指南</p><h1>从准备，<br>到一次训练。</h1><p class="guide-lead">从第一次登录，到一次完整训练。<br>按你正在做的事，找到需要的步骤。</p><a class="guide-start" href="/guide/start">第一次使用，从这里开始 <span aria-hidden="true">↗</span></a></div></section><section class="guide-topics" aria-labelledby="topics-title"><div class="guide-section-heading"><h2 id="topics-title">按功能查阅</h2><span>七个章节，一条清晰的路径。</span></div><div class="guide-cards">${chapters.map((item,i)=>`<a href="/guide/${item.id}" class="guide-card"><span class="guide-number">${String(i+1).padStart(2,'0')}</span><h3>${item.title}</h3><p>${item.description}</p><span class="guide-arrow" aria-hidden="true">↗</span></a>`).join('')}</div></section>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${chapter?chapter.title+' · ':''}使用指南 · STARGATE</title><meta name="description" content="STARGATE 使用指南：注册账号、准备项目、提交训练与管理数据。"><link rel="icon" type="image/svg+xml" href="${guideFavicon}"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/guide.css"><script src="/guide.js" defer></script></head><body><a class="guide-skip" href="#guide-main">跳到正文</a><header class="guide-topbar"><a class="guide-brand" href="/guide" aria-label="STARGATE 使用指南"><span class="guide-wordmark" aria-hidden="true">STARGATE</span><small>使用指南</small></a><a class="guide-return" href="/">返回工作台 <span aria-hidden="true">↗</span></a></header><main id="guide-main" tabindex="-1">${content}</main><footer class="guide-footer"><span>STARGATE · 独立开源研究计算工作台</span><a href="/#community">仍有疑问？前往协作区</a></footer><div id="guide-copy-status" class="guide-sr-only" role="status" aria-live="polite"></div></body></html>`;
}
