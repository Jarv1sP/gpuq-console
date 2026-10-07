import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveEnrollmentRequest,archiveEnrollmentReceipt,archiveEnrollmentKey} from '../dist/archive-enrollment-ui.js';
const request={machine:'node-a',dataset:'samples',version:'a'.repeat(64),ownerId:'demo-user-1',key:'12345678-1234-4234-8234-123456789abc'};
const reply={dataset:request.dataset,version:request.version,localMachine:request.machine,archiveMachine:'node-hdd',phase:'QUEUED',originalRetained:false};
test('admission requires exact owner, target, full hash and immutable UUID; copying is opt-in',()=>{
 const value=archiveEnrollmentRequest(request);assert(Object.isFrozen(value));assert.deepEqual(value,request);assert.equal(Object.hasOwn(value,'copyIfMissing'),false);assert.equal(archiveEnrollmentRequest({...request,copyIfMissing:true}).copyIfMissing,true);
 for(const patch of [{ownerId:'alice'},{ownerId:''},{machine:'auto/path'},{dataset:'../x'},{version:'a'.repeat(12)},{key:'other'},{copyIfMissing:'true'},{source:'/private'},{url:'https://example.com'}])assert.throws(()=>archiveEnrollmentRequest({...request,...patch}));
 assert.notEqual(archiveEnrollmentKey('demo-user-1'),archiveEnrollmentKey('demo-user-2'));
});
test('receipt binds both physical machines and full version; acceptance cannot prove retained original',()=>{
 assert.equal(archiveEnrollmentReceipt(request,reply),reply);
 for(const patch of [{dataset:'other'},{version:'b'.repeat(64)},{localMachine:'node-b'},{archiveMachine:''},{phase:'SUCCESS'},{phase:'UNKNOWN'},{originalRetained:1},{phase:'ARCHIVED',originalRetained:false}])assert.throws(()=>archiveEnrollmentReceipt(request,{...reply,...patch}));
 assert.equal(archiveEnrollmentReceipt(request,{...reply,phase:'ARCHIVED',originalRetained:true}).phase,'ARCHIVED');
});
