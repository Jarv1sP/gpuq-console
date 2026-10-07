import test from 'node:test';
import assert from 'node:assert/strict';
import {projectDiskQuotaHTML} from '../dist/execution-ui.js';

const owner='account-fixture',row={volume:'personal-ssd',bytes:1024**3,inodes:10000,usedBytes:512*1024**2,usedInodes:20,remainingBytes:512*1024**2,remainingInodes:9980};
const enabled=()=>({owner,enabled:true,enforcement:'kernel-project-quota',projectId:10001,volumes:[structuredClone(row)]});
test('quota shows the account volume bytes and file count rather than GPU allowance',()=>{
  const html=projectDiskQuotaHTML(enabled(),owner);assert.match(html,/512 MiB \/ 1 GiB/);assert.match(html,/20 \/ 10,000/);assert.match(html,/personal-ssd/);assert.match(html,/文件与目录/);assert.doesNotMatch(html,/GPU|显卡|张/);
});
test('disabled quota and unactivated owners have no invented zero or unlimited reading',()=>{
  for(const reason of [undefined,'OWNER_NOT_ACTIVATED']){const html=projectDiskQuotaHTML({owner,enabled:false,enforcement:null,volumes:null,...(reason?{reason}:{})},owner);assert.match(html,/未启用/);assert.doesNotMatch(html,/0|无限|progress|容量/);}
});
test('only confirmed enabled counters can display a real zero or exceeded allowance',()=>{
  const empty=enabled();Object.assign(empty.volumes[0],{usedBytes:0,usedInodes:0,remainingBytes:row.bytes,remainingInodes:row.inodes});assert.match(projectDiskQuotaHTML(empty,owner),/0 B \/ 1 GiB/);
  const full=enabled();Object.assign(full.volumes[0],{usedBytes:2*row.bytes,usedInodes:20000,remainingBytes:0,remainingInodes:0});assert.match(projectDiskQuotaHTML(full,owner),/2 GiB \/ 1 GiB/);
});
test('missing, mismatched actor, and non-kernel readings remain unconfirmed',()=>{
  for(const value of [null,{},[],{...enabled(),owner:'other'},{...enabled(),enabled:0},{...enabled(),enforcement:'estimate'},{...enabled(),projectId:0},{...enabled(),volumes:[]}])assert.throws(()=>projectDiskQuotaHTML(value,owner),/待确认/);
});
test('disabled responses with counters or an unknown reason cannot look like a confirmed disabled quota',()=>{
  for(const value of [{owner,enabled:false,enforcement:'kernel-project-quota',volumes:null},{owner,enabled:false,enforcement:null,volumes:[]},{owner,enabled:false,enforcement:null,volumes:null,reason:'unknown'}])assert.throws(()=>projectDiskQuotaHTML(value,owner),/待确认/);
});
test('incomplete, conflicting, unsafe, duplicate or untrusted volume records cannot be rendered',()=>{
  const patches=[{usedBytes:undefined},{usedBytes:-1},{inodes:0},{remainingBytes:0},{remainingInodes:10},{bytes:Infinity},{volume:'<img>'},{volume:'../private'},{usedBytes:Number.MAX_SAFE_INTEGER+1}];
  for(const patch of patches){const value=enabled();Object.assign(value.volumes[0],patch);assert.throws(()=>projectDiskQuotaHTML(value,owner),/待确认/);}
  const duplicate=enabled();duplicate.volumes.push({...row});assert.throws(()=>projectDiskQuotaHTML(duplicate,owner),/待确认/);
});
