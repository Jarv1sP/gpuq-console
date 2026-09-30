import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installCommunity,communityCall,pruneTaskNotes} from '../community.mjs';

function fixture(t){
  const actors=Object.fromEntries(['alice','bob','admin'].map(name=>[name,{userId:name,username:name,role:name==='admin'?'admin':'member'}]));
  const job={id:randomUUID(),userId:'alice',state:'RUNNING',spec:{argv:['PRIVATE-COMMAND']}};
  const service={db:new DatabaseSync(':memory:'),store:{users:Object.values(actors).map(a=>({...a,id:a.userId,name:a.username,enabled:true,password:'PRIVATE-PASSWORD'})),jobs:[job]},audit(){}};
  service.db.exec('CREATE TABLE portal_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  service.save=()=>service.db.prepare('INSERT INTO portal_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify({jobs:service.store.jobs}));service.save();
  installCommunity(service);t.after(()=>service.db.close());
  const call=(operation,args={},actor='alice')=>communityCall(service,actors[actor],'community.'+operation,args);
  const note=(more={},actor='alice')=>call('notes.create',{key:randomUUID(),body:'预计今晚结束',jobId:job.id,...more},actor);
  return {service,job,call,note};
}

for(const state of ['SUCCEEDED','FAILED','CANCELED'])test('task '+state+' deletes bodies, not general notices',t=>{
  const f=fixture(t),key=randomUUID(),request={key,body:'任务留言',jobId:f.job.id};
  const created=f.note(request);
  const general=f.note({jobId:null,body:'长期维护通知'});
  f.job.state=state;f.service.save();assert.equal(f.service.pruneTaskNotes(),1);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM community_notes WHERE job_id IS NOT NULL').get().n,0);
  assert.deepEqual(f.call('notes.list').notes.map(n=>n.id),[general.note.id]);
  const retry=f.call('notes.create',request);assert.equal(retry.id,created.note.id);assert.equal(retry.deleted,true);
  assert.throws(()=>f.note(),e=>e.status===409);
});

for(const state of ['UNKNOWN','LOST','PREEMPTING','PENDING','STARTING','RUNNING'])test(state+' retains task notes',t=>{
  const f=fixture(t);f.note();f.job.state=state;f.job.cancelRequested=true;f.service.save();
  assert.equal(pruneTaskNotes(f.service),0);assert.equal(f.call('notes.list').notes.length,1);
});

test('missing task is not evidence of completion; stored general notices have no chat TTL',t=>{
  const f=fixture(t);f.note();f.note({jobId:null});f.service.store.jobs=[];f.service.save();
  f.service.db.prepare('UPDATE community_notes SET created_at=0').run();
  assert.equal(f.call('notes.list').notes.length,2);
});

test('task attachment requires owner/admin; publication never exposes the private task',t=>{
  const f=fixture(t);
  assert.throws(()=>f.note({},'bob'),e=>e.status===403);
  assert.throws(()=>f.note({jobId:randomUUID()}),e=>e.status===403);
  f.note();f.note({},'admin');
  const publicNotes=f.call('notes.list',{},'bob');
  assert.equal(publicNotes.notes.length,2);
  assert.doesNotMatch(JSON.stringify(publicNotes),/PRIVATE-COMMAND|PRIVATE-PASSWORD|argv|spec/);
  for(const data of [{userId:'admin'},{author_id:'admin'},{state:'SUCCEEDED'}])assert.throws(()=>f.note(data),e=>e.status===400);
});

test('note deletion and revision/identity rules match the existing community contract',t=>{
  const f=fixture(t),n=f.note().note;
  assert.throws(()=>f.call('notes.delete',{id:n.id,revision:1},'bob'),e=>e.status===403);
  assert.throws(()=>f.call('notes.delete',{id:n.id,revision:99}),e=>e.status===409);
  assert.equal(f.call('notes.get',{id:n.id}).note.id,n.id);
  assert.equal(f.call('notes.delete',{id:n.id,revision:1},'admin').deleted,true);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM community_notes').get().n,0);
});

test('notes are separate from posts and chat; cleanup does not change their lifecycle',t=>{
  const f=fixture(t);f.note();
  const post=f.call('posts.create',{key:randomUUID(),kind:'feedback',title:'问题反馈',body:'需要保留'}).post;
  const chat=f.call('chat.send',{key:randomUUID(),body:'普通聊天'}).message;
  f.job.state='SUCCEEDED';f.service.save();f.service.pruneTaskNotes();
  assert.equal(f.call('posts.get',{id:post.id}).post.body,'需要保留');
  assert.equal(f.call('chat.list').messages[0].id,chat.id);
});

test('failed note audit rolls back body, dedup key and rate accounting',t=>{
  const f=fixture(t);f.service.audit=()=>{throw Error('disk error');};
  assert.throws(()=>f.note(),/disk error/);
  for(const table of ['community_notes','community_keys','community_rate'])assert.equal(f.service.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});

test('task ID participates in idempotency digest and general notes cannot be rebound',t=>{
  const f=fixture(t),key=randomUUID();const first=f.note({key,jobId:null});
  assert.equal(f.note({key,jobId:null}).note.id,first.note.id);
  assert.throws(()=>f.note({key}),e=>e.status===409);
  assert.throws(()=>f.call('notes.update',{id:first.note.id,revision:1,jobId:f.job.id,body:'changed'}),e=>e.status===400);
});

test('notes support bounded pagination and author edits without changing task binding',t=>{
  const f=fixture(t),older=f.note().note,newer=f.note({jobId:null}).note;
  const first=f.call('notes.list',{limit:1});
  assert.deepEqual(first.notes.map(n=>n.id),[newer.id]);assert.equal(first.nextCursor,newer.id);
  const second=f.call('notes.list',{limit:1,before:first.nextCursor});
  assert.deepEqual(second.notes.map(n=>n.id),[older.id]);assert.equal(second.nextCursor,null);
  const edited=f.call('notes.update',{id:older.id,revision:1,body:'更新预计完成时间'}).note;
  assert.equal(edited.revision,2);assert.equal(edited.body,'更新预计完成时间');assert.equal(edited.jobId,f.job.id);
  assert.throws(()=>f.call('notes.update',{id:older.id,revision:2,body:'x'.repeat(2001)}),e=>e.status===400);
  assert.throws(()=>f.call('notes.list',{limit:101}),e=>e.status===400);
});
