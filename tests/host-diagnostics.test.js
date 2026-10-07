import test from 'node:test';
import assert from 'node:assert/strict';
import {hostDiagnosticAvailability,hostDiagnosticPresets,hostCommandOutput,rootQueueForbidden,rootQueueHint} from '../dist/host-diagnostics-ui.js';

test('only the two authorised, immutable read-only diagnostics are offered',()=>{
  assert.deepEqual(hostDiagnosticPresets.map(row=>row.argv),[['nvidia-smi'],['df','-h','/data2']]);
  assert.throws(()=>hostDiagnosticPresets[0].argv.push('--reset'));assert.throws(()=>hostDiagnosticPresets.push({argv:['sh']}));
});
test('availability requires a current, reachable node and the exact command contract',()=>{
  const data={gpuq:{stale:false,hosts:[{id:'node-long-example-8',reachable:true,hostCommand:{version:1,available:true}}]}};
  assert.equal(hostDiagnosticAvailability(data,'node-long-example-8'),'');
  for(const available of [false,1,'true',null]){data.gpuq.hosts[0].hostCommand.available=available;assert.match(hostDiagnosticAvailability(data,'node-long-example-8'),/未开启/);}
  data.gpuq.hosts[0].hostCommand.available=true;data.gpuq.stale=true;assert.match(hostDiagnosticAvailability(data,'node-long-example-8'),/采集/);
  data.gpuq.stale=false;data.gpuq.hosts[0].reachable=false;assert.match(hostDiagnosticAvailability(data,'node-long-example-8'),/可达/);
  assert.notEqual(hostDiagnosticAvailability(data,'unknown-node'),'');
});
test('output keeps text and line breaks, exposes terminal controls without HTML or JSON framing',()=>{
  assert.equal(hostCommandOutput({stdout:'GPU 0\nGPU 1',stderr:'bad\x1b\u202e'}),'GPU 0\nGPU 1\n\n错误输出\nbad\\u{001b}\\u{202e}');
  assert.equal(hostCommandOutput({stdout:'<img src=x>'}),'<img src=x>');
});
test('native ROOT identity refusal is distinct from arbitrary portal permission failures',()=>{
  assert.equal(rootQueueHint,'ROOT 不能直接查询调度队列，请用平台任务视图');
  assert.equal(rootQueueForbidden('FORBIDDEN: peer uid is not allowed; run native GPUQ as its service account'),true);
  assert.equal(rootQueueForbidden('{"error":{"code":"FORBIDDEN","message":"peer uid is not allowed"}}'),true);
  assert.equal(rootQueueForbidden('FORBIDDEN: project is not owned by this user'),false);
  assert.equal(rootQueueForbidden('{"code":"FORBIDDEN","message":"permission denied"}'),false);
});
