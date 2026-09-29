import test from 'node:test';
import assert from 'node:assert/strict';
import {createSubmissionKeys,mergeCommunityItems} from '../dist/community-ui.js';

test('unknown sends retain the original key and reject changed payload until confirmed',()=>{
  const keys=createSubmissionKeys(),first=keys.request('post',{body:'正文'});
  keys.uncertain('post');
  assert.equal(keys.request('post',{body:'正文'}).key,first.key);
  assert.throws(()=>keys.request('post',{body:'修改正文'}),/上次发送结果/);
  keys.confirmed('post');
  assert.notEqual(keys.request('post',{body:'正文'}).key,first.key);
});
test('channels and account resets isolate draft keys',()=>{
  const keys=createSubmissionKeys(),a=keys.request('comment:1',{body:'相同'}),b=keys.request('chat',{body:'相同'});
  assert.notEqual(a.key,b.key);keys.uncertain('comment:1');keys.reset();
  assert.equal(keys.hasUncertain('comment:1'),false);
  assert.notEqual(keys.request('comment:1',{body:'相同'}).key,a.key);
});
test('live cursor pages deduplicate repeated IDs while preserving server order',()=>{
  const a={id:'1',body:'first'},b={id:'2',body:'second'},c={id:'3',body:'third'};
  assert.deepEqual(mergeCommunityItems([a,b],[b,c]),[a,b,c]);
});
