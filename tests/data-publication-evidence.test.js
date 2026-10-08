import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationText} from '../dist/data-workspace.js';

test('publication uses only the stage reported for the original operation',()=>{
  for(const [phase,label] of Object.entries({SCANNING:'扫描文件',REGISTERING:'登记数据集',REGISTERED:'登记完成',ARCHIVE_INTENT:'保存到仓库',MATERIALIZING:'复制与校验',COMPLETED:'完成'})){
    assert.equal(publicationText({state:'PUBLISHING',phase}),'发布中 · '+label);
    assert.equal(publicationText({state:'FAILED',phase,error:'拒绝读取'}),'发布失败 · '+label+'：拒绝读取');
  }
});

test('a legacy failure without stage evidence never invents a stage or success',()=>{
  assert.equal(publicationText({state:'FAILED',error:'拒绝读取'}),'发布失败：拒绝读取');
  assert.equal(publicationText({state:'FAILED',phase:null,error:'拒绝读取'}),'发布失败：拒绝读取');
  assert.equal(publicationText({state:'FAILED',phase:'WAIT_FOR_SOURCE',error:'未确认'}),'发布失败 · WAIT_FOR_SOURCE：未确认');
  assert.doesNotMatch(publicationText({state:'FAILED',phase:'REGISTERED',version:'a'.repeat(64),error:'拒绝读取'}),/已发布：|用于训练/);
});

test('stage evidence cannot replace READY or unlock an unknown outcome',()=>{
  assert.match(publicationText({state:'UNKNOWN',phase:'COMPLETED'}),/尚未确认.*暂不可编辑.*不要重复发布/);
  assert.match(publicationText({state:'NOT_READY',phase:'COMPLETED'}),/不再就绪/);
  assert.equal(publicationText({state:'READY',dataset:'sample',version:'a'.repeat(64),phase:'COMPLETED'}),'已发布：sample@'+'a'.repeat(64)+'。可在数据集目录选择用于训练。');
});
