import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetRows} from '../dist/datasets-ui.js';
test('dataset cards keep full immutable versions and escape all text',()=>{
 const html=datasetRows({datasets:[{dataset:'<unsafe>',versions:[{version:'" onfocus="evil',state:'FAILED',bytes:1024,files:1}]}]});
 assert.ok(html.includes('&lt;unsafe&gt;'));assert.ok(html.includes('&quot; onfocus=&quot;evil'));assert.ok(!html.includes('<unsafe>'));
 assert.match(html,/准备失败/);
});
test('only ready datasets can be used and failed preparations can be retried',()=>{
 const ready=datasetRows({datasets:[{dataset:'tiny',versions:[{version:'a'.repeat(64),state:'READY',bytes:1,files:1}]}]});
 assert.match(ready,/data-prepare-dataset="tiny"[^>]+disabled/);assert.doesNotMatch(ready,/data-use-dataset="tiny"[^>]+disabled/);
 const failed=datasetRows({datasets:[{dataset:'tiny',versions:[{version:'a'.repeat(64),state:'FAILED',bytes:1,files:1}]}]});
 assert.doesNotMatch(failed,/data-prepare-dataset="tiny"[^>]+disabled/);assert.match(failed,/data-use-dataset="tiny"[^>]+disabled/);
 assert.match(datasetRows({datasets:[]}),/还没有分配/);
});
