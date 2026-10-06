import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,readdir,chmod,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture,hosts,principal,admin} from './dataset-deletion-fixture.mjs';

test('Portal to real node adapter: last complete personal version remains recoverable; negative namespaces are durable; restore creates a new generation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'portal-real-retention-'));
  t.after(async()=>{
    const writable=async path=>{await chmod(path,0o700);for(const item of await readdir(path,{withFileTypes:true})){
      const child=join(path,item.name);if(item.isDirectory())await writable(child);else if(!item.isSymbolicLink())await chmod(child,0o600);
    }};
    await writable(root);await rm(root,{recursive:true,force:true});
  });
  const f=fixture(t),calls=[];
  const bridge=(host,op,args)=>new Promise((resolve,reject)=>{
    calls.push({host,op,args});
    const child=spawn(process.env.PYTHON||'python3',[new URL('./dataset_deletion_node_fixture.py',import.meta.url).pathname,root]);
    let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    child.on('error',reject);child.on('close',code=>code?reject(Error(stderr)):resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({host,op,args}));
  });
  const source=await bridge(hosts[0],'fixture.publish',{userId:principal.userId,hostAdmin:false});
  const original=join(root,hosts[0],'cache','.registry','personal',source.version+'.json');
  const registered=await readFile(original);
  const originalInode=(await stat(original)).ino;
  f.service.bridge=bridge;
  const r=await f.start({dataset:'personal',version:source.version,key:randomUUID()});
  assert.equal(r.result.state,'DELETED',JSON.stringify(r.result));
  await assert.rejects(readFile(original),e=>e.code==='ENOENT');
  const step=r.result.steps.find(s=>s.machine===hosts[0]);
  const retained=join(root,hosts[0],'cache','.trash','retire-'+step.operationId.replaceAll('-',''),'payload','ready','data','train.txt');
  assert.equal((await readFile(retained)).toString(),'actual complete recoverable bytes');
  for(const host of hosts){
    const fence=JSON.parse(await readFile(join(root,host,'cache','.retirements','personal',source.version+'.json')));
    assert.equal(fence.state,'ISOLATED');
  }
  const count=calls.length;await f.call('datasets.delete.status',{key:r.args.key});
  assert.ok(calls.slice(count).every(c=>c.op==='storage.dataset-delete.status'));
  assert.equal((await f.call('datasets.delete.restore',{operationId:r.first.operationId,machine:hosts[0]},admin)).state,'RESTORED');
  assert.deepEqual(await readFile(original),registered);
  assert.notEqual((await stat(original)).ino,originalInode,'restoration must persist a new registration generation');
  assert.equal((await readFile(join(root,hosts[0],'cache','ready','personal',source.version,'data','train.txt'))).toString(),'actual complete recoverable bytes');
  for(const host of hosts){
    const fence=JSON.parse(await readFile(join(root,host,'cache','.retirements','personal',source.version+'.json')));
    assert.equal(fence.state,host===hosts[0]?'RESTORED':'RELEASED');
  }
});
