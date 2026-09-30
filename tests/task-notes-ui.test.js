import test from 'node:test';
import assert from 'node:assert/strict';
import {selectableNoteJobs} from '../dist/task-notes-ui.js';
import {createSubmissionKeys} from '../dist/submission-keys.js';

test('notes task choices are own nonterminal jobs, retaining UNKNOWN and waiting tasks',()=>{
  const jobs=['RUNNING','PENDING','UNKNOWN','WAITING_POOL','SUCCEEDED','FAILED','CANCELED'].map((state,index)=>({id:String(index),userId:'alice',name:state,state}));
  const store={principal:{userId:'alice',role:'member'},jobs:[...jobs,{id:'other',userId:'bob',state:'RUNNING'}]};
  assert.deepEqual(selectableNoteJobs(store).map(job=>job.state),['RUNNING','PENDING','UNKNOWN','WAITING_POOL']);
  store.principal.role='admin';assert.equal(selectableNoteJobs(store).some(job=>job.id==='other'),false);
});

test('note lifetime participates in retry identity and uncertain content cannot be replaced',()=>{
  const keys=createSubmissionKeys(),first=keys.request('note',{body:'message',jobId:'own-task'});keys.uncertain('note');
  assert.equal(keys.request('note',{body:'message',jobId:'own-task'}).key,first.key);
  assert.throws(()=>keys.request('note',{body:'message'}),/尚未确认/);
  keys.confirmed('note');assert.notEqual(keys.request('note',{body:'message'}).key,first.key);
});
