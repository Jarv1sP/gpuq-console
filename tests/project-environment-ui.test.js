import test from 'node:test';
import assert from 'node:assert/strict';
import {projectStatusText} from '../dist/execution-ui.js';
test('project environment label preserves old shared default and makes isolation explicit',()=>{
  assert.match(projectStatusText({state:'DRAFT'}),/共享基础包（旧默认）/);
  assert.match(projectStatusText({state:'READY',environmentMode:'isolated'}),/完全隔离（不继承基础包）/);
  assert.match(projectStatusText({state:'READY',environmentMode:'oci'}),/OCI/);
  assert.match(projectStatusText({state:'READY',environmentMode:'shared'}),/共享基础包/);
});
test('publication reports observed counts without inventing totals and renders error details as plain text',()=>{
  assert.match(projectStatusText({state:'PUBLISHING',progress:{phase:'copying',completedEntries:12,completedBytes:512,totalEntries:20,totalBytes:1024}}),/复制：12 \/ 20 项，512 \/ 1024 B/);
  const unknown=projectStatusText({state:'PUBLISHING',progress:{phase:'scanning',completedEntries:0,completedBytes:0,totalEntries:null,totalBytes:null}});
  assert.match(unknown,/扫描：0 项，0 B/);assert.doesNotMatch(unknown,/100%|NaN|null/);
  const detail={path:'code/<img onerror=alert(1)>',kind:'file',mode:'0o664',links:2,remediation:'make an independent copy'};
  const text=projectStatusText({state:'FAILED',error:'failed',errorDetails:detail},true);
  for(const value of Object.values(detail))assert.ok(text.includes(String(value)));
  assert.match(text,/先结束项目开发终端/);
});
