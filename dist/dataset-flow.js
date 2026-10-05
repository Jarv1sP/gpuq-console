// Public catalog facts only. Absence, readiness and preserved originals are
// separate facts; no machine role, release event or progress is inferred.
import {transferBytes} from './data-route.js';
import {serverIdHTML} from './workbench-ui.js';
import {copyHelp} from './copy-help-ui.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Use the shared vector help button and viewport-clamped top-layer popover.
export const datasetInfoHTML=(text,label='说明')=>copyHelp(label,text).replace('class="copy-help"','class="copy-help ui-info"').replace('class="copy-help-popup"','class="copy-help-popup ui-info-content"').replace('<strong>','<b class="dataset-help-label">').replace('</strong>','</b>');
export function discloseDatasetInfo(element,label){
  if(!element||element.closest('.ui-info'))return;
  const template=document.createElement('template');template.innerHTML=datasetInfoHTML('',label);
  const help=template.content.firstElementChild;element.before(help);
  // Preserve the original note and its aria-describedby ID.
  help.querySelector('.copy-help-popup>span').replaceWith(element);element.hidden=false;
}
const phases={QUEUED:'等待存入',COPYING:'存入中',PROVISIONING:'校验中',CERTIFYING:'检查恢复能力',ARCHIVED:'原件已保存',FAILED:'存入数据库失败',BLOCKED:'待确认'};
const order=['QUEUED','COPYING','PROVISIONING','CERTIFYING','ARCHIVED'];
const amount=value=>Number.isFinite(value)&&value>=0?transferBytes(value):null;
const storageRows=version=>(version?.locations||[]).filter(row=>row.storage&&typeof row.storage==='object');
// publicRow may use the logical dataset alias while a location retains the
// node's physical identifier. The attached record and immutable hash bind it.
const matching=(row,version)=>row.storage.version===version.version&&typeof row.storage.dataset==='string'&&row.storage.dataset.length>0;
export function hasDatabaseOriginal(version){
  return storageRows(version).some(row=>matching(row,version)&&row.storage.phase==='ARCHIVED'&&row.storage.originalRetained===true&&typeof row.storage.archiveMachine==='string'&&row.storage.archiveMachine.length>0);
}
export function databaseSummary(version){
  const rows=storageRows(version);
  if(!rows.length)return {kind:'none',phase:null,machine:null,saved:false,label:'仅本机缓存 · 未存入数据库'};
  const machines=new Set(rows.map(row=>row.storage.archiveMachine));
  const machine=machines.size===1&&typeof rows[0].storage.archiveMachine==='string'&&rows[0].storage.archiveMachine?rows[0].storage.archiveMachine:null;
  if(rows.some(row=>row.storage.phase==='FAILED'))return {kind:'failed',phase:'FAILED',machine,saved:false,label:phases.FAILED};
  if(!machine||rows.some(row=>!matching(row,version)||!Object.hasOwn(phases,row.storage.phase)||row.storage.phase==='BLOCKED'||row.storage.phase==='ARCHIVED'&&row.storage.originalRetained!==true))return {kind:'unknown',phase:'BLOCKED',machine,saved:false,label:'待确认'};
  const phase=order.find(value=>rows.some(row=>row.storage.phase===value));
  return {kind:phase==='ARCHIVED'?'saved':'pending',phase,machine,saved:phase==='ARCHIVED',label:phases[phase]};
}
export function cacheFact(version,machine,catalog,state){
  const location=(version.locations||[]).find(row=>row.machine===machine);
  const canPrepare=machine===catalog.machine?version.canPrepare===true:location?.canPrepare===true;
  const kind=state==='READY'?'ready':state==='PREPARING'?'fetch':state==='FAILED'?'failed':state==='UNKNOWN'?'unknown':['NOT_LOCAL','REGISTERED'].includes(state)&&canPrepare&&hasDatabaseOriginal(version)?'recoverable':state==='STAGING'?'staging':'none';
  const label={ready:'缓存就绪',fetch:'取回中',failed:'取回失败',unknown:'待确认',recoverable:'可从数据库取回',staging:'上传未完成',none:'未准备'}[kind];
  // Current catalog has no progress field. A future verified caller may pass
  // explicit byte progress; never use a catalog refresh or elapsed time.
  return {kind,label,progress:null};
}
export function cacheProgress(progress){
  if(!progress||!Number.isSafeInteger(progress.totalBytes)||progress.totalBytes<=0||!Number.isSafeInteger(progress.remainingBytes)||progress.remainingBytes<0||progress.remainingBytes>progress.totalBytes)return null;
  return Math.floor((progress.totalBytes-progress.remainingBytes)/progress.totalBytes*100);
}
export function cacheIconHTML(fact){
  const progress=fact.kind==='fetch'?cacheProgress(fact.progress):null;
  const height=progress===null?0:14*progress/100;
  return `<span class="dataset-location-icon" aria-hidden="true">${progress===null?'':`<svg viewBox="0 0 14 14"><rect x="0" y="${14-height}" width="14" height="${height}" fill="currentColor"/></svg>`}</span>`;
}
export function databaseGroundHTML(version){
  const state=databaseSummary(version);
  return `<div class="dataset-ground dataset-ground-${state.kind}" data-database-state="${state.kind}" role="status"><svg viewBox="0 0 1000 8" preserveAspectRatio="none" aria-hidden="true">${state.kind==='none'?'<line x1="0" y1="7" x2="1000" y2="7" stroke-dasharray="3 6"/>':'<path d="M0 7 Q500 0 1000 7 Q500 4.2 0 7Z"/>'}</svg><div class="dataset-ground-label">${state.kind==='none'?esc(state.label):`<span>数据库</span>${state.machine?serverIdHTML(state.machine):''}<span>${esc(state.label)}</span>`}</div></div>`;
}
export function datasetLifecycle(version,catalog,{upload}={}){
  const ground=databaseSummary(version),local=(version.locations||[]).find(row=>row.machine===catalog.machine);
  const localState=local?.state||version.state;
  const stages=[];
  if(upload?.state==='READY'&&upload.machine===catalog.machine&&upload.version===version.version&&upload.dataset===version.dataset)stages.push({label:'上传',state:'complete'});
  if((version.locations||[]).some(row=>row.state==='READY'))stages.push({label:'缓存就绪',state:'complete'});
  if(ground.kind!=='none'){
    stages.push({label:'存入数据库',state:ground.saved?'complete':ground.kind==='pending'?'current':'unknown'});
    stages.push({label:'原件已保存',state:ground.saved?'complete':'pending'});
  }
  if(localState==='PREPARING')stages.push({label:'取回到 '+catalog.machine,state:'current'});
  if(localState==='FAILED')stages.push({label:'取回失败',state:'failed'});
  if(localState==='UNKNOWN')stages.push({label:'缓存待确认',state:'unknown'});
  if(localState==='READY')stages.push({label:'可用于训练',state:'complete'});
  return stages;
}
// Read-only route evidence also survives an in-progress preparation. The
// matrix's clickable route keeps its existing NOT_LOCAL admission checks.
export function datasetFlowRoute(version,catalog){
  if(!['NOT_LOCAL','PREPARING'].includes(version.state)||version.canPrepare!==true)return null;
  const source=version.sourceMachine,target=catalog.machine;
  if(typeof source!=='string'||!source||source===target||!(catalog.machines||[]).some(row=>row.machine===target&&row.state==='ok'))return null;
  if(!(version.locations||[]).some(row=>row.machine===source&&row.state==='READY'))return null;
  return {source,target,bytes:Number.isSafeInteger(version.bytes)&&version.bytes>=0?version.bytes:null};
}
export function datasetFlowDetailHTML(dataset,version,catalog,route,options={}){
  const stages=datasetLifecycle({...version,dataset},catalog,options);
  const local=(version.locations||[]).find(row=>row.machine===catalog.machine),physical=typeof local?.dataset==='string'&&local.dataset?local.dataset:null;
  // Storage management addresses the node's actual cache identifier. Logical
  // catalog aliases are for training; they must not target another cache.
  const pin=physical?`<div class="dataset-pin-slot" data-cache-pin-slot data-dataset="${esc(physical)}" data-version="${esc(version.version)}" data-machine="${esc(catalog.machine)}"></div>`:'';
  return `<div class="dataset-flow-detail"><div class="dataset-hash-label"><span>完整版本</span><button class="button quiet dataset-hash-copy" type="button" data-copy-dataset-version="${esc(version.version)}" aria-label="复制完整版本">复制</button></div><code class="dataset-full-hash">${esc(version.version)}</code>${stages.length?`<ol class="dataset-lifecycle" aria-label="已确认的数据阶段">${stages.map(stage=>`<li data-stage-state="${stage.state}"><span class="dataset-stage-dot" aria-hidden="true"></span><span title="${esc(stage.label)}">${esc(stage.label)}</span></li>`).join('')}</ol>`:''}${route?`<div class="dataset-flow-route"><span>缓存 ${serverIdHTML(route.source)}</span><span class="dataset-flow-arrow" aria-hidden="true">→</span><span>缓存 ${serverIdHTML(route.target)}</span>${route.bytes===null?'':`<span class="mono">${esc(amount(route.bytes))}</span>`}</div>`:''}${pin}</div>`;
}
export function uploadJourneyHTML(route,machine,state){
  const known=['campus-direct','vps-relay'].includes(route?.kind),complete=state==='READY';
  const sending=['RECEIVING_MANIFEST','SEALING','UPLOADING','PUBLISHING'].includes(state);
  const source=complete||sending?'complete':['HASHING'].includes(state)?'current':'pending';
  const cache=complete?'complete':sending?'current':'pending';
  return `<ol class="dataset-upload-journey" aria-label="上传数据路线"><li data-stage-state="${source}"><span class="dataset-stage-dot" aria-hidden="true"></span><span>你的电脑</span></li><li data-stage-state="${cache}"><span class="dataset-journey-channel">${known?route.kind==='campus-direct'?'直传':'中转':'通道未确认'}</span><span class="dataset-stage-dot" aria-hidden="true"></span><span>${machine?serverIdHTML(machine):'所选服务器'} 缓存</span></li><li data-stage-state="${complete?'complete':'pending'}"><span class="dataset-stage-dot" aria-hidden="true"></span><span>可用于训练</span></li></ol>`;
}
export function cacheBudget(status,plan){
  if(typeof status?.enabled!=='boolean'||typeof plan?.enabled!=='boolean'||status.enabled!==plan.enabled)return {kind:'unknown'};
  if(!plan.enabled)return {kind:'disabled'};
  const {usageBytes,budgetBytes,lowWater,highWater}=plan;
  if(!Number.isSafeInteger(usageBytes)||usageBytes<0||!Number.isSafeInteger(budgetBytes)||budgetBytes<=0||!Number.isFinite(lowWater)||!Number.isFinite(highWater)||lowWater<0||highWater>1||lowWater>=highWater)return {kind:'unknown'};
  const ratio=usageBytes/budgetBytes;
  if(!Number.isFinite(ratio))return {kind:'unknown'};
  return {kind:ratio>=highWater?'high':'known',ratio,usageBytes,budgetBytes,lowWater,highWater};
}
export function cacheGaugeHTML(machine,status,plan,index=0){
  const budget=cacheBudget(status,plan),known=['known','high'].includes(budget.kind);
  const candidates=Array.isArray(plan?.candidates)?plan.candidates:[],unknown=(Array.isArray(plan?.protectedUnknown)?plan.protectedUnknown.length:0)+(Array.isArray(plan?.unavailableAuthorities)?plan.unavailableAuthorities.length:0);
  const marks=known?`<line x1="${budget.lowWater*100}" x2="${budget.lowWater*100}" y1="0" y2="12" class="cache-mark-low"/><line x1="${budget.highWater*100}" x2="${budget.highWater*100}" y1="0" y2="12" class="cache-mark-high"/>`:'';
  const id='cache-stripes-'+index,width=known?Math.min(100,budget.ratio*100):0,high=known?budget.highWater*100:100;
  return `<article class="dataset-cache-gauge" data-budget-state="${budget.kind}"><h4>${serverIdHTML(machine)}</h4><div class="dataset-cache-number">${known?Math.round(budget.ratio*100)+'%':'—'}${known?`<small>${esc(amount(budget.usageBytes))} / ${esc(amount(budget.budgetBytes))}</small>`:''}</div><svg class="dataset-cache-meter" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true"><defs><pattern id="${id}" width="4" height="8" patternUnits="userSpaceOnUse"><path d="M-2 8 L6 0 M2 8 L10 0" class="cache-over-stripe"/></pattern></defs><rect x="0" y="4" width="100" height="4" class="cache-meter-track"/><rect x="0" y="4" width="${Math.min(width,high)}" height="4" class="cache-meter-fill"/>${width>high?`<rect x="${high}" y="4" width="${width-high}" height="4" fill="url(#${id})"/>`:''}${marks}</svg>${known?`<div class="dataset-cache-ticks"><span>低 ${Math.round(budget.lowWater*100)}%</span><span>高 ${Math.round(budget.highWater*100)}%</span></div>`:''}<p>${budget.kind==='disabled'?'自动释放未开启':budget.kind==='unknown'?'预算状态待确认':budget.kind==='high'?'超过高水位':candidates.length?`预览 ${candidates.length} 项`:'当前不需要释放'}</p>${unknown?`<p class="dataset-cache-unknown">${unknown} 项状态待确认，不会被释放</p>`:''}</article>`;
}
export function cachePreviewHTML(machine,plan){
  if(plan?.enabled!==true)return '';
  if(!Array.isArray(plan.candidates))return '<p class="dataset-cache-unknown">释放预览未确认</p>';
  const time=value=>{const date=new Date(value*1000);return Number.isFinite(value)&&value>0&&Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'未提供';};
  return `<section class="dataset-cache-preview"><h4>${serverIdHTML(machine)} <span>超过高水位时将释放（预览，不会立即删除）</span></h4>${plan.candidates.length?`<div class="dataset-cache-preview-table" role="table" aria-label="缓存释放预览"><div class="dataset-cache-preview-row" role="row"><span role="columnheader">数据集 · 版本</span><span role="columnheader">大小</span><span role="columnheader">最近使用</span></div>${plan.candidates.map(row=>`<div class="dataset-cache-preview-row" role="row"><span role="cell"><code>${esc(row.dataset)}</code><small>${esc(String(row.version||'').slice(0,12))}</small></span><span role="cell">${esc(amount(row.bytes)||'未提供')}</span><span role="cell">${esc(time(row.lastUsedAt))}</span></div>`).join('')}</div>`:'<p>当前不需要释放</p>'}</section>`;
}
export const cacheBudgetInfo=()=>datasetInfoHTML('按已登记缓存估算，含元数据；不是磁盘实际占用。预览不会立即删除数据，已确认的原件不参与释放。','缓存预算说明');
