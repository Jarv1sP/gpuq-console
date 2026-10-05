import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmProjectCreation,projectEnvironmentLabel,projectPublicationStorage,projectPublicationOutcome,projectPublicationDelay,projectPublicationProgressHTML} from '../dist/workbench-ui.js';
import {validProject} from '../dist/execution-ui.js';

const key='b69e7f69-18e8-4496-864e-e612195a2e93',other='086d123e-834b-43da-aa24-c33566d1b3f4',release='a'.repeat(64);
const intent={machine:'fixture-server-long-id',project:'experiment-a',key,startedAt:1000};
function memory(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),key:index=>[...values.keys()][index],get length(){return values.size;}};}
test('all environment choices confirm the requested project and retain the shared legacy default',()=>{
  for(const environmentMode of ['shared','isolated','oci']){
    const result={project:intent.project,environmentMode};assert.equal(confirmProjectCreation(result,{project:intent.project,environmentMode}),result);
    for(const actual of ['shared','isolated','oci',null,'container'])if(actual!==environmentMode)assert.throws(()=>confirmProjectCreation({...result,environmentMode:actual},{project:intent.project,environmentMode}),/未确认/);
    assert.throws(()=>confirmProjectCreation({project:'another',environmentMode},{project:intent.project,environmentMode}),/身份/);
  }
  const legacy={project:intent.project};assert.equal(confirmProjectCreation(legacy,{project:intent.project,environmentMode:'shared'}),legacy);
  for(const mode of ['isolated','oci','invalid'])assert.throws(()=>confirmProjectCreation(legacy,{project:intent.project,environmentMode:mode}));
  assert.equal(projectEnvironmentLabel('oci'),'个人容器');assert.equal(projectEnvironmentLabel('isolated'),'隔离');assert.equal(projectEnvironmentLabel(undefined),'共享');assert.equal(projectEnvironmentLabel(null),'环境未确认');
});
test('name validation applies the exact boundary before any create request',()=>{
  for(const name of ['a','a_1-b','a'.repeat(48)])assert.equal(validProject(name),true);
  for(const name of ['',null,['a'],'1a','A','a.b','a/b',' a','a ','a'.repeat(49)])assert.equal(validProject(name),false);
});
test('publication confirmation needs the matching receipt and a READY immutable release',()=>{
  const ready={state:'READY',releases:[{release,state:'READY'}],publication:{id:key,state:'READY',release}};
  assert.deepEqual(projectPublicationOutcome(ready,intent),{state:'READY',release});
  for(const value of [undefined,{}, {...ready,publication:undefined},{...ready,publication:{...ready.publication,id:other}},{...ready,publication:{id:key,state:'READY',release:'latest'}},{...ready,releases:[{release,state:'PUBLISHING'}]},{...ready,releases:[]},{...ready,publication:{id:key,state:'UNKNOWN'}},{...ready,publication:{id:key,state:'READY',release:[release]}}])assert.deepEqual(projectPublicationOutcome(value,intent),{state:'UNKNOWN'});
  assert.deepEqual(projectPublicationOutcome({...ready,state:'READY',publication:{id:key,state:'PUBLISHING'}},intent),{state:'PUBLISHING'},'an old READY release cannot complete the current request');
  const errorDetails={path:'code/<bad>',remediation:'make a copy'};
  assert.deepEqual(projectPublicationOutcome({...ready,error:'copy failed',errorDetails,publication:{id:key,state:'FAILED'}},intent),{state:'FAILED',error:'copy failed',errorDetails});
});
test('refresh recovery is account, machine and project scoped, and stale success cannot clear a newer request',()=>{
  const storage=memory(),cache=projectPublicationStorage(storage);assert.deepEqual(cache.save('member-a',intent),intent);
  const refreshed=projectPublicationStorage(storage);assert.deepEqual(refreshed.read('member-a',intent.machine,intent.project),intent);
  assert.equal(refreshed.read('member-b',intent.machine,intent.project),null);assert.deepEqual(refreshed.list('member-b'),[]);
  assert.equal(refreshed.read('member-a','other-server',intent.project),null);assert.equal(refreshed.read('member-a',intent.machine,'other-project'),null);
  const newer={...intent,key:other,startedAt:2000};cache.save('member-a',newer);cache.clear('member-a',intent);assert.deepEqual(cache.list('member-a'),[newer]);
  cache.clear('member-a',newer);assert.equal(cache.read('member-a',intent.machine,intent.project),null);
});
test('unavailable storage refuses a new write intent; malformed stored records are not replayed',()=>{
  const broken=projectPublicationStorage({setItem(){throw Error('disabled');},getItem(){throw Error('disabled');}});
  assert.throws(()=>broken.save('member-a',intent),/未发送/);assert.equal(broken.read('member-a',intent.machine,intent.project),null);
  const storage=memory(),cache=projectPublicationStorage(storage);cache.save('member-a',intent);const entry=storage.key(0);
  for(const invalid of ['bad json','null',JSON.stringify({...intent,key:'not-a-uuid'}),JSON.stringify({...intent,project:'../private'}),JSON.stringify({...intent,machine:'other'}),JSON.stringify({...intent,startedAt:'1000'})]){storage.setItem(entry,invalid);assert.equal(cache.read('member-a',intent.machine,intent.project),null);assert.deepEqual(cache.list('member-a'),[]);}
});
test('query backoff is 2, 5, then 10 seconds and observed phases never invent progress',()=>{
  assert.deepEqual([0,1,2,3,60].map(projectPublicationDelay),[2000,5000,10000,10000,10000]);
  const scanning=projectPublicationProgressHTML({phase:'scanning',completedEntries:0,totalEntries:null});assert.match(scanning,/aria-current="step".*扫描/);assert.match(scanning,/0 项/);assert.doesNotMatch(scanning,/%|null|剩余/);
  const copying=projectPublicationProgressHTML({phase:'copying',completedEntries:12,totalEntries:20});assert.match(copying,/12 \/ 20 项/);assert.match(copying,/aria-current="step".*复制/);
  for(const value of [undefined,{phase:'invented'}])assert.equal(projectPublicationProgressHTML(value),'');
});
