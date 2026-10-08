import test from 'node:test';
import assert from 'node:assert/strict';
import {createJobResultAccess,ownResultJob,successfulResult,resultPullCommand,resultFilePath,resultFilesHTML} from '../dist/job-results-ui.js';
const job={id:'10000000-0000-4000-8000-000000000001',userId:'alice',machine:'training-node',project:'vision-demo',release:'a'.repeat(64),nodeJobId:'J0123456789ab',state:'SUCCEEDED'};
const completion=(patch={})=>({protocol:'job-completion-v1',readOnly:true,jobId:job.id,userId:job.userId,machine:job.machine,project:job.project,release:job.release,nodeJobId:job.nodeJobId,completed:true,state:'SUCCEEDED',completedAttempt:{id:'A'+'b'.repeat(32)},...patch});
function fixture(reply=()=>completion()){
 const listeners=new Set(),calls=[],store={production:true,principal:{userId:'alice',role:'member'},authGeneration:0,jobs:[{...job}],onAuthChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},call:async(op,args,{signal})=>{calls.push({op,args,signal});return reply(args);}},ui=createJobResultAccess({store});
 return {ui,store,calls,listeners};
}
test('only own completed fixed task evidence enables pull; old, missing and mismatched protocols do not',async t=>{
 const f=fixture();t.after(()=>f.ui.destroy());assert.equal(f.ui.allowed(job),false);assert.match(f.ui.markup(job),/ hidden/);assert.equal(await f.ui.check(job),true);assert.equal(f.ui.allowed(job),true);assert.match(f.ui.markup(job),/拉取结果/);assert.deepEqual(f.calls[0].args,{jobId:job.id});assert.equal(f.calls[0].op,'jobs.completion');
 for(const patch of [{completed:false,state:'UNCONFIRMED'},{protocol:'legacy'},{readOnly:false},{jobId:'other'},{userId:'other'},{machine:'other'},{nodeJobId:'other'},{project:'other'},{release:'b'.repeat(64)},{completedAttempt:null},{state:'FAILED'}])assert.equal(successfulResult(completion(patch),job),false,JSON.stringify(patch));
 for(const patch of [{state:'RUNNING'},{source:'native'},{userId:'bob'},{cancelRequested:true},{project:undefined},{id:'short'}])assert.equal(ownResultJob(f.store,{...job,...patch}),false);
 f.store.principal.role='admin';assert.equal(ownResultJob(f.store,{...job,userId:'bob'}),false,'admin does not read other owners outputs');
});
test('lost, denied or unsupported completion remains hidden; force check never reuses success',async t=>{
 let mode='success';const f=fixture(()=>{if(mode==='success')return completion();throw Object.assign(Error('unavailable'),{status:mode==='permission'?403:404});});t.after(()=>f.ui.destroy());await f.ui.check(job);assert.equal(f.ui.allowed(job),true);
 mode='permission';assert.equal(await f.ui.check(job,true),false);assert.equal(f.ui.allowed(job),false);assert.equal(f.calls.length,2);assert.equal(await f.ui.check(job),false);assert.equal(f.calls.length,2,'failed background read is not repeatedly probed');
 mode='missing';assert.equal(await f.ui.check(job,true),false);assert.equal(f.ui.allowed(job),false);assert.equal(f.calls.length,3);
});
test('account switch or immutable job change cancels or retires completion responses',async t=>{
 let release;const f=fixture(()=>new Promise(resolve=>release=resolve));t.after(()=>f.ui.destroy());const pending=f.ui.check(job);await Promise.resolve();f.store.principal.userId='bob';f.store.authGeneration++;for(const listener of f.listeners)listener();assert.equal(f.calls[0].signal.aborted,true);release(completion());assert.equal(await pending,false);assert.equal(f.ui.allowed(job),false);
 const g=fixture(()=>new Promise(resolve=>release=resolve));t.after(()=>g.ui.destroy());const reading=g.ui.check(job);await Promise.resolve();g.store.jobs[0].project='another';release(completion());assert.equal(await reading,false);assert.equal(g.ui.allowed(g.store.jobs[0]),false);
});
test('sync checks eligible jobs serially and repeated sync does not poll or mutate',async t=>{
 const f=fixture();t.after(()=>f.ui.destroy());f.ui.sync(f.store.jobs);await f.ui.check(job);f.ui.sync(f.store.jobs);await Promise.resolve();assert.equal(f.calls.length,1);assert.equal(f.ui.allowed(job),true);f.ui.accept(job,completion({completed:false,state:'UNCONFIRMED'}));assert.equal(f.ui.allowed(job),false);assert.equal(f.calls.some(row=>/submit|cancel|delete|files/.test(row.op)),false);
});
test('result paths and CLI keep fixed output identity and quote hostile filenames',()=>{
 assert.equal(resultFilePath('.','metrics.json'),'metrics.json');assert.equal(resultFilePath('checkpoints','best.bin'),'checkpoints/best.bin');
 for(const name of ['..','/etc/passwd','a/b','bad\\name','a\nname'])assert.throws(()=>resultFilePath('.',name));
 assert.equal(resultPullCommand(job,'metrics.json'),'gpuctl pull metrics.json LOCAL_FILE --machine training-node --project vision-demo --job '+job.id);
 const command=resultPullCommand(job,"checkpoints/model '$(printf bad).bin");assert(command.includes("'checkpoints/model '\"'\"'$(printf bad).bin'"));assert(command.endsWith('--job '+job.id));assert(resultPullCommand(job,'-flag').startsWith('gpuctl pull ./-flag '));assert.throws(()=>resultPullCommand(job,'../secret'));
});
test('directory rows have no fake sizes, result names are escaped, no total or download status',()=>{
 const html=resultFilesHTML([{name:'checkpoints',type:'directory',size:4096},{name:'<img onerror=bad>',type:'file',size:4096},{name:'symlink',type:'unsupported',size:1}],'.');
 assert.match(html,/data-result-type="directory"/);assert.match(html,/4.0 KiB/);assert.doesNotMatch(html,/<img|已下载|总大小|4096 B|symlink/);assert.match(html,/&lt;img/);assert.equal((html.match(/job-result-file/g)||[]).length,2);assert.match(resultFilesHTML([],'checkpoints'),/上一级/);assert.throws(()=>resultFilesHTML([{name:'..',type:'file',size:0}],'.'));
});
