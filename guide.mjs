import {readFile} from 'node:fs/promises';

export const chapters=[
  {id:'start',title:'首次使用',description:'注册账号，获得额度，连上你的工作空间。'},
  {id:'development',title:'项目开发',description:'上传代码、安装依赖，准备可重复运行的版本。'},
  {id:'training',title:'提交训练',description:'发布后运行，选择多卡、弹性或共享方式。'},
  {id:'data',title:'数据集',description:'上传、准备和使用数据；大文件也有合适的方式。'},
  {id:'results',title:'日志与结果',description:'查询进度，设置通知与留言，下载结果。'},
  {id:'queue',title:'排队与协作',description:'分清等级、抢占、保存让位与自动恢复。'},
  {id:'troubleshooting',title:'常见问题',description:'手动同步、排查故障，申请系统维修。'},
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
export function renderMarkdown(source){
  const lines=source.replaceAll('\r','').split('\n');let output='',paragraph=[],list=null;
  const flush=()=>{if(paragraph.length){output+=`<p>${inline(paragraph.join(' '))}</p>`;paragraph=[];}if(list){output+=`</${list}>`;list=null;}};
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line.startsWith('```')){
      flush();const code=[];while(++i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i]);
      output+=`<div class="guide-code"><div class="guide-code-bar"><span>命令行</span><button type="button" class="copy-code" hidden aria-label="复制这段命令">复制</button></div><pre tabindex="0"><code>${escape(code.join('\n'))}</code></pre></div>`;continue;
    }
    if(!line.trim()){flush();continue;}
    if(line.startsWith('### ')){flush();output+=`<h2>${inline(line.slice(4))}</h2>`;continue;}
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
export async function guidePage(chapter,origin){
  const sections=parseGuide((await readFile(new URL('./docs/USER_GUIDE.md',import.meta.url),'utf8')).replaceAll('https://gpu.example.com',origin));
  const nav=chapters.map((item,index)=>`<a href="/guide/${item.id}"${chapter?.id===item.id?' aria-current="page"':''}><span class="guide-number">${String(index+1).padStart(2,'0')}</span><span>${item.title}</span><span class="guide-arrow" aria-hidden="true">↗</span></a>`).join('');
  const index=chapter?chapters.findIndex(item=>item.id===chapter.id):-1;
  const sibling=(item,label)=>item?`<a href="/guide/${item.id}"><small>${label}</small><span>${item.title} <span aria-hidden="true">→</span></span></a>`:'<span></span>';
  const content=chapter?`<div class="guide-layout"><aside class="guide-sidebar"><a class="guide-overview" href="/guide">全部内容</a><nav aria-label="指南章节">${nav}</nav></aside><article class="guide-article"><header><p class="guide-eyebrow">使用指南 / ${String(index+1).padStart(2,'0')}</p><h1>${chapter.title}</h1><p class="guide-lead">${chapter.description}</p></header><div class="guide-prose">${renderMarkdown(sections.get(chapter.id))}</div><nav class="guide-pagination" aria-label="相邻章节">${sibling(chapters[index-1],'上一章')}${sibling(chapters[index+1],'下一章')}</nav></article></div>`:
    `<section class="guide-hero"><div><p class="guide-eyebrow">GPUQ / 使用指南</p><h1>把想法，<br>交给算力。</h1><p class="guide-lead">从第一次登录，到一次完整训练。<br>按你正在做的事，找到需要的步骤。</p><a class="guide-start" href="/guide/start">第一次使用，从这里开始 <span aria-hidden="true">↗</span></a></div><div class="guide-orbit" aria-hidden="true"><span></span><i></i><b>G</b></div></section><section class="guide-topics" aria-labelledby="topics-title"><div class="guide-section-heading"><h2 id="topics-title">按功能查阅</h2><span>七个章节，一条清晰的路径。</span></div><div class="guide-cards">${chapters.map((item,i)=>`<a href="/guide/${item.id}" class="guide-card"><span class="guide-number">${String(i+1).padStart(2,'0')}</span><h3>${item.title}</h3><p>${item.description}</p><span class="guide-arrow" aria-hidden="true">↗</span></a>`).join('')}</div></section>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${chapter?chapter.title+' · ':''}使用指南 · GPUQ</title><meta name="description" content="GPUQ 使用指南：注册账号、准备项目、提交训练与管理数据。"><link rel="stylesheet" href="/guide.css"><script src="/guide.js" defer></script></head><body><a class="guide-skip" href="#guide-main">跳到正文</a><header class="guide-topbar"><a class="guide-brand" href="/guide"><span>G</span>GPUQ <small>使用指南</small></a><a class="guide-return" href="/">返回工作台 <span aria-hidden="true">↗</span></a></header><main id="guide-main" tabindex="-1">${content}</main><footer class="guide-footer"><span>GPUQ · 让实验有序进行</span><a href="/#community">仍有疑问？前往协作区</a></footer><div id="guide-copy-status" class="guide-sr-only" role="status" aria-live="polite"></div></body></html>`;
}
