// Fixed-version metadata only. No content download or machine selection.
const datasetID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,versionID=/^[a-f0-9]{64}$/;
const safePath=value=>typeof value==='string'&&(value===''||value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[\\\x00-\x1f\x7f]/.test(part))&&!value.startsWith('/'));
const unavailable=error=>[403,404].includes(error?.status)||['UNKNOWN_OPERATION','OPERATION_NOT_FOUND','UNSUPPORTED_OPERATION'].includes(error?.code)||/未知(?:执行)?操作|unknown operation|unsupported operation|operation (?:not found|does not exist)/i.test(error?.message||'');
const folder=path=>({path,entries:[],nextCursor:null,loaded:false,expanded:true,busy:false,error:false,retryCursor:null});

export function createFilesPreview({store,dataset,version,signal,changed=()=>{}}){
 const lifetime=new AbortController(),account=store.principal?.userId,generation=store.authGeneration;
 const directories=new Map([['',folder('')]]);let closed=false,unsupported=false;
 const live=()=>!closed&&!signal?.aborted&&store.production===true&&!!account&&store.principal?.enabled!==false&&store.principal?.userId===account&&store.authGeneration===generation;
 const valid=typeof dataset==='string'&&typeof version==='string'&&datasetID.test(dataset)&&versionID.test(version);
 function snapshot(){return {visible:live()&&valid&&!unsupported,directories:new Map([...directories].map(([path,node])=>[path,{...node,entries:node.entries.map(row=>({...row}))}]))};}
 const emit=()=>changed(snapshot());
 function destroy(){if(closed)return;closed=true;lifetime.abort();unsubscribe?.();directories.clear();emit();}
 const unsubscribe=store.onAuthChange?.(destroy);
 signal?.addEventListener('abort',destroy,{once:true});
 lifetime.signal.addEventListener('abort',()=>signal?.removeEventListener('abort',destroy),{once:true});
 function page(value,path,cursor){
  if(value?.protocol!=='dataset-files-list-v1'||value.available!==true||!Array.isArray(value.entries)||value.entries.length>200||value.nextCursor!==null&&(typeof value.nextCursor!=='string'||!value.nextCursor)||value.nextCursor&&value.nextCursor===cursor)throw Error('Unconfirmed directory page');
  for(const [key,expected] of Object.entries({dataset,version,path}))if(value[key]!==undefined&&value[key]!==expected)throw Error('Mismatched directory page');
  const seen=new Set();
  for(const entry of value.entries){
   if(!entry||typeof entry.name!=='string'||!entry.name||entry.name.includes('/')||!safePath(entry.name)||entry.path!==(path?path+'/':'')+entry.name||!['file','directory'].includes(entry.type)||entry.type==='directory'&&entry.bytes!==null||entry.type==='file'&&entry.bytes!==null&&(!Number.isSafeInteger(entry.bytes)||entry.bytes<0)||seen.has(entry.path))throw Error('Unconfirmed directory entry');
   seen.add(entry.path);
  }
  return value;
 }
 async function load(path='',cursor=null){
  const node=directories.get(path);
  if(!live()||!valid||unsupported||!node||node.busy||!safePath(path))return false;
  node.busy=true;node.error=false;emit();
  try{
   const args={dataset,version,...(path?{path}:{}),...(cursor?{cursor}:{})};
   const result=await store.call('datasets.files.list',args,{signal:lifetime.signal});
   if(!live())return false;
   if(result?.available===false){unsupported=true;lifetime.abort();directories.clear();return false;}
   const value=page(result,path,cursor),entries=cursor?[...node.entries,...value.entries]:value.entries;
   if(new Set(entries.map(row=>row.path)).size!==entries.length)throw Error('Duplicate directory entry');
   node.entries=entries;node.nextCursor=value.nextCursor;node.loaded=true;node.retryCursor=null;
   return true;
  }catch(error){
   if(!live()||lifetime.signal.aborted)return false;
   if(unavailable(error)){unsupported=true;lifetime.abort();directories.clear();}
   else{node.error=true;node.retryCursor=cursor;}
   return false;
  }finally{node.busy=false;if(live())emit();}
 }
 async function toggle(path){
  if(!live()||unsupported)return false;
  let node=directories.get(path);
  if(node){node.expanded=!node.expanded;emit();if(!node.expanded||node.loaded||node.busy)return true;}
  else{
   if(![...directories.values()].some(parent=>parent.entries.some(row=>row.type==='directory'&&row.path===path)))return false;
   node=folder(path);directories.set(path,node);
  }
  return load(path);
 }
 const more=path=>{const node=directories.get(path);return node?.nextCursor?load(path,node.nextCursor):Promise.resolve(false);};
 const retry=path=>{const node=directories.get(path);return node?.error?load(path,node.retryCursor):Promise.resolve(false);};
 if(signal?.aborted)destroy();
 return {snapshot,load:()=>load(''),toggle,more,retry,destroy};
}

const sizes=value=>{if(value===null)return '未知';const units=['B','KiB','MiB','GiB','TiB'];let index=0;while(value>=1024&&index<4){value/=1024;index++;}return value.toFixed(index?1:0)+' '+units[index];};
const mounted=new WeakMap();
function style(){if(!document.querySelector('link[data-files-preview-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/dataset-files-preview.css';link.dataset.filesPreviewStyle='';document.head.append(link);}}
function icon(type){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 20 20');svg.setAttribute('aria-hidden','true');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',type==='directory'?'M2 5h6l2 2h8v10H2Z M2 5V3h6l2 2':'M5 2h7l4 4v12H5Z M12 2v5h4');svg.append(path);return svg;}
export function mountFilesPreview(host,options){
 mounted.get(host)?.destroy();
 const lifetime=new AbortController();let root=null,api;
 const element=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
 function render(value){
  if(!value.visible){root?.remove();root=null;return;}
  const first=value.directories.get('');
  if(!first||!first.entries.length&&!first.error&&!first.nextCursor){root?.remove();root=null;return;}
  if(!root){style();root=element('section','files-preview');root.setAttribute('aria-label','文件目录');host.append(root);}
  const focused=document.activeElement?.closest('[data-files-toggle],[data-files-more],[data-files-retry]'),focusKey=focused&&root.contains(focused)?[...focused.attributes].find(attr=>attr.name.startsWith('data-files-')):null;
  function rows(node,depth){
   const list=element('ul','files-preview-list');list.setAttribute('aria-busy',String(node.busy));
   for(const entry of node.entries){
    const item=element('li','files-preview-item'),isDirectory=entry.type==='directory',child=value.directories.get(entry.path),row=element(isDirectory?'button':'div','files-preview-row');
    row.style.setProperty('--files-level',depth);row.append(icon(entry.type));
    const name=element('span','files-preview-name',entry.name);name.title=entry.name;row.append(name);
    if(isDirectory){row.type='button';row.dataset.filesToggle=entry.path;row.setAttribute('aria-expanded',String(child?.expanded===true));row.setAttribute('aria-label',entry.name);row.append(element('span','files-preview-chevron',child?.expanded?'−':'+'));}
    else row.append(element('span','files-preview-size',sizes(entry.bytes)));
    item.append(row);if(child?.expanded)item.append(rows(child,depth+1));list.append(item);
   }
   if(node.error||node.nextCursor){
    const item=element('li','files-preview-footer');item.style.setProperty('--files-level',depth);
    const button=element('button','files-preview-action',node.error?'重试':'加载更多');button.type='button';button.disabled=node.busy;
    if(node.error){const error=element('span','files-preview-error','无法读取');error.setAttribute('role','alert');item.append(error);button.dataset.filesRetry=node.path;}
    else button.dataset.filesMore=node.path;
    item.append(button);list.append(item);
   }
   return list;
  }
  root.replaceChildren(rows(first,0));
  if(focusKey)for(const node of root.querySelectorAll('button'))if(node.getAttribute(focusKey.name)===focusKey.value){node.focus({preventScroll:true});break;}
 }
 api=createFilesPreview({...options,changed:render});
 host.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!root?.contains(button)||button.disabled)return;
  if(button.hasAttribute('data-files-toggle'))void api.toggle(button.dataset.filesToggle);
  if(button.hasAttribute('data-files-more'))void api.more(button.dataset.filesMore);
  if(button.hasAttribute('data-files-retry'))void api.retry(button.dataset.filesRetry);
 },{signal:lifetime.signal});
 function destroy(){lifetime.abort();api.destroy();options.signal?.removeEventListener('abort',destroy);root?.remove();root=null;if(mounted.get(host)===result)mounted.delete(host);}
 const result={destroy};mounted.set(host,result);options.signal?.addEventListener('abort',destroy,{once:true});
 if(options.signal?.aborted)destroy();else void api.load();
 return result;
}
