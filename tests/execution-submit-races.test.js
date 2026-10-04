import test from 'node:test';
import assert from 'node:assert/strict';
import {createSubmitSelectionGuard} from '../dist/execution-ui.js';

const oldRef='sample@'+'a'.repeat(64),newRef='sample@'+'d'.repeat(64);
test('a delayed lookup never replaces the newest fixed dataset choice on the same machine',()=>{
 const guard=createSubmitSelectionGuard(),old=guard.begin('gpu-1',oldRef,'member-epoch-1'),next=guard.begin('gpu-1',newRef,'member-epoch-1');
 assert.equal(guard.current(old,'gpu-1','member-epoch-1'),false);
 assert.equal(guard.current(next,'gpu-1','member-epoch-1'),true);
 assert.equal(next.datasetRef,newRef);assert.ok(Object.isFrozen(next));
});
test('selected machine and authenticated project epoch are checked independently of request generation',()=>{
 const guard=createSubmitSelectionGuard(),choice=guard.begin('gpu-1',newRef,'member-auth-1-project-1');
 assert.equal(guard.current(choice,'gpu-2','member-auth-1-project-1'),false);
 for(const identity of ['other-member-auth-1-project-1','member-auth-2-project-1','member-auth-1-project-2','member-auth-1-another-room'])assert.equal(guard.current(choice,'gpu-1',identity),false);
 assert.equal(guard.current(choice,'gpu-1','member-auth-1-project-1'),true);
});
test('closing a submit sheet or editing its draft invalidates a pending old continuation',()=>{
  const guard=createSubmitSelectionGuard(),old=guard.begin('gpu-1',oldRef,'identity');guard.invalidate();
 assert.equal(guard.current(null,'gpu-1','identity'),false);
 assert.equal(guard.current(old,'gpu-1','identity'),false);
 const next=guard.begin('gpu-1',newRef,'identity');assert.equal(guard.current(next,'gpu-1','identity'),true);assert.equal(guard.current(old,'gpu-1','identity'),false);
});
