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
test('personal uploads without a configured source show resume guidance instead of a broken prepare action',()=>{
 const staging=datasetRows({datasets:[{dataset:'u-user-private',versions:[{version:'a'.repeat(64),state:'STAGING',canPrepare:false}]}]});
 assert.doesNotMatch(staging,/data-prepare-dataset/);assert.match(staging,/重新选择同一目录继续上传/);assert.match(staging,/data-use-dataset="u-user-private"[^>]+disabled/);
 const ready=datasetRows({datasets:[{dataset:'u-user-private',versions:[{version:'a'.repeat(64),state:'READY',canPrepare:false}]}]});
 assert.doesNotMatch(ready,/data-prepare-dataset/);assert.doesNotMatch(ready,/data-use-dataset="u-user-private"[^>]+disabled/);
});
test('evicted workspace publications guide users to republish, not resume a directory upload',()=>{
 const html=datasetRows({datasets:[{dataset:'w-user-private',versions:[{version:'a'.repeat(64),state:'REGISTERED',canPrepare:false}]}]});
 assert.match(html,/个人数据空间.*重新发布/);assert.doesNotMatch(html,/继续上传|data-prepare-dataset/);assert.match(html,/data-use-dataset="w-user-private"[^>]+disabled/);
});
