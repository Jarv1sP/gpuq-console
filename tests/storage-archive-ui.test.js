import test from 'node:test';
import assert from 'node:assert/strict';
import {transferCard} from '../dist/transfers-ui.js';
test('managed archive uses dataset retry instead of a broken generic copy resume',()=>{
  const normal={id:'fixture',kind:'copy',state:'FAILED',machine:'cold',from:'hot'};
  assert.match(transferCard(normal),/data-transfer-action="resume"/);
  const html=transferCard({...normal,managedArchive:1});
  assert.doesNotMatch(html,/data-transfer-action="resume"/);
  assert.match(html,/长期原件保存|数据集.*重试/);
  assert.match(html,/data-transfer-action="cancel"/);
});
