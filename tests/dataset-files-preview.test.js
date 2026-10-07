import test from 'node:test';
import assert from 'node:assert/strict';
import {createFilesPreview} from '../dist/dataset-files-preview.js';
const version='a'.repeat(64),entry=(name,type='file',path=name)=>({name,path,type,bytes:type==='directory'?null:4096});
const page=(entries=[],nextCursor=null,extra={})=>({protocol:'dataset-files-list-v1',available:true,entries,nextCursor,...extra});
function fixture(reply){
 const calls=[],listeners=new Set(),store={production:true,principal:{userId:'alice',enabled:true},authGeneration:0,onAuthChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},call:async(op,args,options)=>{assert.equal(op,'datasets.files.list');calls.push({op,args,signal:options.signal});return reply(args,calls.length);}};
 const ui=createFilesPreview({store,dataset:'sample',version});
 return {ui,store,calls,listeners,close:()=>ui.destroy()};
}
test('fixed version root, lazy folders, independent opaque cursors and cached expansion',async t=>{
 const cursors=['opaque/root+1','opaque/child+1'];
 const f=fixture(args=>args.path==='train'?args.cursor?page([entry('two.bin','file','train/two.bin')]):page([entry('one.bin','file','train/one.bin')],cursors[1]):args.cursor?page([entry('LICENSE')]):page([entry('train','directory'),entry('README.md')],cursors[0]));t.after(f.close);
 assert.equal(await f.ui.load(),true);assert.deepEqual(f.calls[0].args,{dataset:'sample',version});assert.equal(f.calls.length,1,'root never recursively reads children');
 await f.ui.toggle('train');assert.deepEqual(f.calls[1].args,{dataset:'sample',version,path:'train'});
 await f.ui.more('train');assert.deepEqual(f.calls[2].args,{dataset:'sample',version,path:'train',cursor:cursors[1]});
 await f.ui.more('');assert.deepEqual(f.calls[3].args,{dataset:'sample',version,cursor:cursors[0]});
 assert.deepEqual(f.ui.snapshot().directories.get('train').entries.map(row=>row.name),['one.bin','two.bin']);
 assert.deepEqual(f.ui.snapshot().directories.get('').entries.map(row=>row.name),['train','README.md','LICENSE']);
 await f.ui.toggle('train');await f.ui.toggle('train');assert.equal(f.calls.length,4,'closing and reopening a loaded folder reuses only this version');
 assert.equal(await f.ui.toggle('../private'),false);assert.equal(f.calls.length,4,'no client-supplied host, owner or arbitrary directory');
});
test('available false, 403, 404 and nonexistent operation hide every previously read folder',async t=>{
 for(const error of [{available:false,reason:'DATASET_FILES_NODE_UNAVAILABLE'},...['403','404'].map(status=>Object.assign(Error('denied'),{status:Number(status)})),Error('未知执行操作。'),Error('Unknown operation')]){
  const f=fixture((args,count)=>{if(count===1)return page([entry('train','directory')]);if(error instanceof Error)throw error;return error;});
  await f.ui.load();assert.equal(f.ui.snapshot().visible,true);await f.ui.toggle('train');assert.equal(f.ui.snapshot().visible,false);assert.equal(f.ui.snapshot().directories.size,0);assert.equal(f.calls[0].signal.aborted,true);f.close();
 }
});
test('network retry preserves the failed page cursor and does not silently restart pagination',async t=>{
 const f=fixture((args,count)=>{if(count===1)return page([entry('train','directory')],'root-token');if(count===2)throw Object.assign(Error('timeout'),{code:'REQUEST_TIMEOUT'});return page([entry('tail.bin')]);});t.after(f.close);
 await f.ui.load();assert.equal(await f.ui.more(''),false);let root=f.ui.snapshot().directories.get('');assert.equal(root.error,true);assert.equal(root.entries.length,1);assert.equal(root.nextCursor,'root-token');
 assert.equal(await f.ui.retry(''),true);assert.deepEqual(f.calls[2].args,f.calls[1].args);root=f.ui.snapshot().directories.get('');assert.equal(root.error,false);assert.equal(root.entries.length,2);assert.equal(root.nextCursor,null);
 assert.equal(await f.ui.more(''),false);assert.equal(f.calls.length,3);
});
test('aborted dataset and account requests cannot display late entries or reuse cursors',async t=>{
 let resolve;const f=fixture(()=>new Promise(done=>resolve=done));t.after(f.close);
 const pending=f.ui.load();f.store.principal.userId='bob';f.store.authGeneration++;for(const listener of f.listeners)listener();
 assert.equal(f.calls[0].signal.aborted,true);resolve(page([entry('private.txt')],'alice-cursor'));await pending;assert.equal(f.ui.snapshot().visible,false);assert.equal(f.ui.snapshot().directories.size,0);
 const signal=new AbortController(),calls=[];
 const ui=createFilesPreview({store:{production:true,principal:{userId:'bob'},authGeneration:1,call:async(op,args,{signal})=>{calls.push({args,signal});return page([entry('other.txt')]);}},dataset:'other',version:'b'.repeat(64),signal:signal.signal});t.after(()=>ui.destroy());
 await ui.load();assert.deepEqual(calls[0].args,{dataset:'other',version:'b'.repeat(64)});signal.abort();assert.equal(calls[0].signal.aborted,true);assert.equal(ui.snapshot().directories.size,0);assert.equal(ui.snapshot().visible,false);
});
test('parallel duplicate loads coalesce and lifetime abortion reaches transport',async t=>{
 let resolve;const f=fixture(()=>new Promise(done=>resolve=done));t.after(f.close);const pending=f.ui.load();assert.equal(await f.ui.load(),false);assert.equal(f.calls.length,1);f.ui.destroy();assert.equal(f.calls[0].signal.aborted,true);resolve(page([entry('late.txt')]));await pending;assert.equal(f.ui.snapshot().visible,false);
});
test('malformed, mismatched, unsafe and oversized pages cannot become a false empty directory',async t=>{
 for(const invalid of [page([],null,{protocol:'wrong'}),page([],null,{version:'b'.repeat(64)}),page([],null,{dataset:'another'}),page([],null,{path:'private'}),page([entry('../private')]),page([entry('name','file','host/name')]),page([entry('folder','directory')],null,{entries:[{...entry('folder','directory'),bytes:10}]}),page([{...entry('data'),bytes:-1}]),page([entry('a'),entry('a')]),page(Array.from({length:201},(_,i)=>entry('file'+i))),{protocol:'dataset-files-list-v1',available:true,entries:[]}]){
  const f=fixture(()=>invalid);assert.equal(await f.ui.load(),false);const root=f.ui.snapshot().directories.get('');assert.equal(root.error,true);assert.equal(root.loaded,false);assert.deepEqual(root.entries,[]);f.close();
 }
});
test('invalid target, anonymous, disabled or demo accounts do not request metadata',async()=>{
 for(const props of [{dataset:'../sample'},{version:'short'},{dataset:['sample']},{store:{production:true,principal:null}},{store:{production:true,principal:{userId:'alice',enabled:false}}},{store:{production:false,principal:{userId:'alice'}}}]){
  let calls=0;const store={production:true,principal:{userId:'alice'},call:async()=>{calls++;return page();},...props.store};
  const ui=createFilesPreview({dataset:'sample',version,...props,store});await ui.load();assert.equal(calls,0);assert.equal(ui.snapshot().visible,false);ui.destroy();
 }
});
