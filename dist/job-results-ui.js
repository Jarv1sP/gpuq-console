import {completionMatchesJob} from './job-diagnostics-ui.js';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,projectID=/^[a-z][a-z0-9_-]{0,47}$/;
const ended=new Set(['SUCCEEDED','FAILED','CANCELED']);
const resultReminder='请及时将结果下载到自己的电脑；平台不会自动备份或删除。';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function ownResultJob(store,job){return store.production===true&&store.principal?.enabled!==false&&!!store.principal?.userId&&job?.userId===store.principal.userId&&job.source!=='native'&&ended.has(job.state)&&!job.cancelRequested&&typeof job.id==='string'&&typeof job.machine==='string'&&typeof job.project==='string'&&uuid.test(job.id)&&id.test(job.machine)&&projectID.test(job.project);}
export function successfulResult(value,job){return completionMatchesJob(value,job)&&value.completed===true&&value.state==='SUCCEEDED'&&value.project===job.project&&(!job.release||value.release===job.release);}
export function resultFilePath(directory,name){
 const valid=value=>typeof value==='string'&&value&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[\\\x00-\x1f\x7f]/.test(part));
 if(!valid(name)||name.includes('/')||directory!=='.'&&!valid(directory))throw Error('结果文件路径未确认。');
 return directory==='.'?name:directory+'/'+name;
}
export function resultPullCommand(job,path){
 resultFilePath('.',path.split('/').at(-1));for(const part of path.split('/'))resultFilePath('.',part);
 if(!id.test(job.machine||'')||!projectID.test(job.project||'')||!uuid.test(job.id||''))throw Error('任务结果身份未确认。');
 const quote=value=>/^[A-Za-z0-9_./-]+$/.test(value)?value:"'"+value.replaceAll("'","'\"'\"'")+"'";
 return 'gpuctl pull '+quote(path.startsWith('-')?'./'+path:path)+' LOCAL_FILE --machine '+quote(job.machine)+' --project '+quote(job.project)+' --job '+job.id;
}
export function resultFilesHTML(entries,directory){
 if(!Array.isArray(entries)||entries.length>1000)throw Error('结果目录未确认。');
 const size=value=>Number.isSafeInteger(value)&&value>=0?(value>=1024**2?(value/1024**2).toFixed(1)+' MiB':value>=1024?(value/1024).toFixed(1)+' KiB':value+' B'):'未知';
 const rows=entries.filter(row=>['file','directory'].includes(row?.type)).map(row=>{
  const path=resultFilePath(directory,row.name),folder=row.type==='directory';
  return `<button type="button" class="job-result-file" data-result-path="${esc(path)}" data-result-type="${folder?'directory':'file'}" title="${esc(row.name)}"><span aria-hidden="true">${folder?'▱':'□'}</span><span>${esc(row.name)}</span><span class="mono">${folder?'':size(row.size)}</span></button>`;
 });
 if(directory!=='.'){const parent=directory.includes('/')?directory.slice(0,directory.lastIndexOf('/')):'.';rows.unshift(`<button type="button" class="job-result-file" data-result-path="${esc(parent)}" data-result-type="directory"><span aria-hidden="true">↑</span><span>上一级</span><span></span></button>`);}
 return rows.join('');
}
export function createJobResultAccess({store,changed=()=>{}}){
 const proofs=new Map(),attempted=new Set(),pending=new Map(),controllers=new Set();let queue=[],busy=false,turn=0;
 const binding=job=>JSON.stringify([store.principal?.userId,store.authGeneration,job?.id,job?.userId,job?.machine,job?.project,job?.release,job?.nodeJobId,job?.state,job?.cancelRequested===true]);
 const current=job=>(store.jobs||[]).find(row=>row.id===job.id);
 const allowed=job=>ownResultJob(store,job)&&proofs.get(binding(job))===true;
 function accept(job,value){const live=current(job);if(!live||binding(live)!==binding(job)||!ownResultJob(store,live))return false;const valid=successfulResult(value,live);if(valid)proofs.set(binding(live),true);else proofs.delete(binding(live));changed();return valid;}
 async function check(job,force=false){
  if(!ownResultJob(store,job))return false;
  const key=binding(job),generation=turn;
  if(pending.has(key))return pending.get(key);if(!force&&attempted.has(key))return allowed(job);
  attempted.add(key);proofs.delete(key);changed();const controller=new AbortController();controllers.add(controller);
  const read=Promise.resolve().then(async()=>{
   if(controller.signal.aborted||generation!==turn||binding(current(job))!==key)return false;
   try{const value=await store.call('jobs.completion',{jobId:job.id},{signal:controller.signal});if(controller.signal.aborted||generation!==turn||binding(current(job))!==key)return false;return accept(job,value);}
   catch{if(generation===turn){proofs.delete(key);changed();}return false;}
   finally{controllers.delete(controller);if(pending.get(key)===read)pending.delete(key);}
  });pending.set(key,read);return read;
 }
 async function drain(){if(busy)return;busy=true;try{while(queue.length)await check(queue.shift());}finally{busy=false;}}
 function sync(jobs){queue=[...jobs].reverse().filter(job=>ownResultJob(store,job)&&!attempted.has(binding(job)));void drain();paint();}
 function markup(job){if(!ownResultJob(store,job))return '';return `<span data-job-result-slot="${esc(job.id)}" ${allowed(job)?'':'hidden'}>${allowed(job)?`<button class="button quiet" type="button" data-job-pull="${esc(job.id)}" title="${resultReminder}">拉取结果</button>`:''}</span>`;}
 function paint(root=globalThis.document){
  for(const slot of root?.querySelectorAll?.('[data-job-result-slot]')||[]){const job=(store.jobs||[]).find(row=>row.id===slot.dataset.jobResultSlot),show=allowed(job);slot.hidden=!show;if(show&&!slot.firstElementChild){const button=slot.ownerDocument.createElement('button');button.className='button quiet';button.type='button';button.dataset.jobPull=job.id;button.title=resultReminder;button.textContent='拉取结果';slot.append(button);}else if(!show)slot.replaceChildren();}
 }
 function clear(){turn++;queue=[];for(const controller of controllers)controller.abort();controllers.clear();proofs.clear();attempted.clear();pending.clear();changed();}
 const unsubscribe=store.onAuthChange?.(clear);
 return {allowed,accept,check,sync,markup,paint,clear,destroy(){clear();unsubscribe?.();}};
}
