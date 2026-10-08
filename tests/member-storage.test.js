import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptProjectUsage,memberStorageGroups} from '../dist/member-storage-model.js';
const principal={userId:'me',username:'me',role:'member'},machines=[{id:'node-a'},{id:'node-b'}],version='a'.repeat(64);
const dataset=(dataset,canUse,ownerLabel,states=['READY','READY'])=>({dataset,displayName:dataset,versions:[{version,bytes:20,canUse,ownerLabel,servers:states.map((state,i)=>({machine:machines[i].id,state,observed:true}))}]});
const catalog={partial:false,datasets:[dataset('own',false,'所属用户：me'),dataset('grant',true,'所属用户：other',['READY','PREPARING']),dataset('private',false,'所属用户：other')]};
const projects=new Map(machines.map(row=>[row.id,{confirmed:true,projects:[]}]));
const run=options=>memberStorageGroups({principal,machines,catalog,projects,...options});
test('project usage only accepts confirmed numeric bytes, never strings or guessed totals',()=>{
 for(const bytes of [0,1,1024,Number.MAX_SAFE_INTEGER])assert.equal(adaptProjectUsage({bytes}),bytes);
 for(const raw of [null,{}, {size:50},{bytes:null},{bytes:'50'},{bytes:NaN},{bytes:Infinity},{bytes:-1},{bytes:1.5},{bytes:Number.MAX_SAFE_INTEGER+1}])assert.equal(adaptProjectUsage(raw),null);
});
test('personal caches include own and granted observed READY copies only, also for administrators',()=>{
 for(const role of ['member','admin']){
  const groups=run({principal:{...principal,role}});assert.deepEqual(groups.map(row=>[row.machine,row.items.map(item=>item.dataset),row.totalBytes]),[['node-a',['own','grant'],40],['node-b',['own'],20]]);
 }
 const unobserved=structuredClone(catalog);unobserved.datasets[0].versions[0].servers[1].observed=false;
 assert.deepEqual(run({catalog:unobserved}).map(row=>row.machine),['node-a']);
 assert.deepEqual(run({principal:null}),[]);assert.deepEqual(run({machines:[]}),[]);
 assert.deepEqual(run({machines:[machines[1]]}).map(row=>row.machine),['node-b']);
});
test('OCI rows are scoped to the listing machine and current account; unknown bytes suppress totals',()=>{
 const listing=new Map(projects);listing.set('node-a',{confirmed:true,projects:[null,{project:'train',displayName:'训练容器',environmentMode:'oci'},{project:'train',environmentMode:'oci'},{project:'shared',environmentMode:'shared'},{project:'foreign',environmentMode:'oci',userId:'other'}]});
 const groups=run({projects:listing});assert.equal(groups[0].items.filter(row=>row.kind==='project').length,1);assert.equal(groups[0].projectBytes,null);assert.equal(groups[0].totalBytes,null);assert.equal(groups[1].totalBytes,20);
 const usage=new Map([[JSON.stringify(['node-a','train']),{bytes:60}]]);assert.equal(run({projects:listing,usage})[0].totalBytes,100);
 assert.equal(run({projects:listing,usage,catalog:{...catalog,partial:true}})[0].totalBytes,null);
 assert.equal(run({projects:new Map([['node-a',{...listing.get('node-a'),confirmed:false}]]),usage})[0].totalBytes,null);
 assert.equal(run({projects:listing,usage,catalog:null})[0].totalBytes,null);
 assert.equal(run({projects:listing,principal:{userId:'other',username:'other',role:'member'}})[0].items.some(row=>row.dataset==='own'),false);
});
test('duplicate catalog locations are counted once and unknown cache sizes never become zero',()=>{
 const value=structuredClone(catalog);value.datasets[0].versions[0].servers.push({...value.datasets[0].versions[0].servers[0]});
 assert.equal(run({catalog:value})[0].totalBytes,40);value.datasets[0].versions[0].bytes=null;assert.equal(run({catalog:value})[0].totalBytes,null);
 value.datasets[0].versions[0].bytes=0;assert.equal(run({catalog:value})[0].totalBytes,20);
});
