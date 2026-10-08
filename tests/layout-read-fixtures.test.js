import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutReadReply} from './layout-read-fixtures.mjs';
import {completionMatchesJob} from '../dist/job-diagnostics-ui.js';
import {successfulResult} from '../dist/job-results-ui.js';
const userId='fixture-owner',machine='fixture-node',project='fixture-project',release='a'.repeat(64),now=Math.floor(Date.now()/1000);
const job={id:'10000000-0000-4000-8000-000000000001',userId,machine,project,release,nodeJobId:'J0123456789ab',state:'SUCCEEDED',
 latestAttempt:{id:'A'+'b'.repeat(32),ordinal:1,state:'EXITED_SUCCESS',exitCode:0,failureReason:null,startedAt:now-900,finishedAt:now-300}};
job.spec={id:job.id,userId,machine,project,release,argv:['python','train.py']};
const principal={userId,role:'member'},state={jobs:[job],machines:[{id:machine}],users:[{id:userId,name:'夹具用户'}]};
test('layout completion uses the real owner-bound success and unconfirmed contract',()=>{
 const confirmed=layoutReadReply('jobs.completion',{jobId:job.id},{principal,state,completion:'confirmed'});
 assert.equal(completionMatchesJob(confirmed,job),true);assert.equal(successfulResult(confirmed,job),true);
 assert.equal(confirmed.nativeObservation.status,'CONFIRMED');assert.equal(confirmed.completedAttempt.id,job.latestAttempt.id);assert.match(confirmed.specSha256,/^[a-f0-9]{64}$/);
 const unknown=layoutReadReply('jobs.completion',{jobId:job.id},{principal,state});
 assert.equal(completionMatchesJob(unknown,job),true);assert.equal(unknown.state,'UNCONFIRMED');assert.equal(unknown.completed,false);
 assert.equal(unknown.nativeObservation.status,'UNKNOWN');assert.equal(successfulResult(unknown,job),false);
 assert.throws(()=>layoutReadReply('jobs.completion',{jobId:job.id},{principal:{userId:'other',role:'admin'},state}));
 assert.throws(()=>layoutReadReply('jobs.completion',{jobId:job.id,userId},{principal,state}));
});
test('layout training capabilities bind the exact machine and full version without granting a read',()=>{
 const args={machine,dataset:'fixture-data',version:release},reply=layoutReadReply('datasets.training.capabilities',args,{principal,state});
 assert.deepEqual(reply,{protocol:1,...args,warehouse:{available:false,reason:'本地夹具未提供仓库读取证明'}});
 assert.throws(()=>layoutReadReply('datasets.training.capabilities',{...args,version:'short'},{principal,state}));
});
test('layout usage preserves null measurements and the administrator-only users scope',()=>{
 const mine=layoutReadReply('storage.usage.mine',{}, {principal,state});assert.equal(mine.protocol,1);assert.equal(mine.machines.length,1);
 assert.equal(mine.machines[0].projectBytes,null);assert.equal(mine.machines[0].collectedAt,null);assert.equal(mine.machines[0].complete,false);
 const users=layoutReadReply('storage.usage.users',{}, {principal:{...principal,role:'admin'},state});assert.equal(users.users[0].userId,userId);assert.deepEqual(users.users[0].machines,mine.machines);
 assert.throws(()=>layoutReadReply('storage.usage.users',{}, {principal,state}));
 assert.throws(()=>layoutReadReply('storage.usage.mine',{userId:'other'}, {principal,state}));
});
