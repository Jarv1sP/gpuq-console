import test from 'node:test';
import assert from 'node:assert/strict';
import {runCloudImport} from '../client-cloud-import.mjs';
import {checkedImportURL,importRows} from '../dist/cloud-import-ui.js';
const id='a0000000-0000-4000-8000-000000000001';
const base={machines:[],datasets:[]};
function run(action,tail=[],options={},call=()=>assert.fail('unexpected API call'),stderr={write(){}}){
  return runCloudImport({action,positionals:['data',action,...tail],options:{...base,...options},machine:'node-a',call,stderr});
}

test('HTTPS resume replaces only the short link on the same operation ID',async()=>{
  const calls=[];const result=await run('import-resume',[id],{'source-url':'https://downloads.example.test/a?token=new'},async(op,args)=>{calls.push({op,args});return {result:{operationId:id,state:'QUEUED'}};});
  assert.equal(result.operationId,id);assert.deepEqual(calls,[{op:'cloud.import.resume',args:{machine:'node-a',operationId:id,url:'https://downloads.example.test/a?token=new'}}]);
  await run('import-resume',[id],{},async(op,args)=>{assert(!('url' in args));return {result:{state:'RUNNING'}};});
});
test('unsafe replacement URLs and flags for the wrong action fail before network',async()=>{
  for(const url of ['http://example.test/a','https://user:pass@example.test/a','https://example.test:8443/a','https://example.test/a#token','https://example.test/\nsecret','not-a-url']){
    assert.throws(()=>checkedImportURL(url));
    await assert.rejects(()=>run('import-resume',[id],{'source-url':url}));
  }
  await assert.rejects(()=>run('imports',[],{'source-url':'https://example.test/a'}),/仅用于/);
  await assert.rejects(()=>run('import-status',[id],{key:id}),/新建导入参数/);
  await assert.rejects(()=>run('import-resume',['\u001b[2J']),/UUID/);
  await assert.rejects(()=>run('import',['https://example.test/a','incoming/a'],{key:'bad\nkey'}),/UUID/);
  await assert.rejects(()=>run('import',['https://example.test/a','incoming/a'],{'password-code':'secret'}),/仅用于/);
  await assert.rejects(()=>run('import',['https://www.alipan.com/s/test'],{sha256:'a'.repeat(64)}),/校验信息/);
});
test('uncertain start prints and preserves the key, emits no source URL and never retries automatically',async()=>{
  const output=[],calls=[];const stderr={write:text=>output.push(text)};
  const call=async(op,args)=>{calls.push({op,args});throw Error('response lost');};
  await assert.rejects(()=>run('import',['https://example.test/archive?secret=private','incoming/data.zip'],{key:id},call,stderr),/response lost/);
  assert.equal(calls.length,1);assert.equal(calls[0].args.key,id);assert(output.join('').includes('data import-status '+id));assert(output.join('').includes('--key '+id));assert(!output.join('').includes('private'));
  await assert.rejects(()=>run('import',['https://example.test/archive?secret=private','incoming/data.zip'],{key:id},call,stderr));
  assert.equal(calls[1].args.key,calls[0].args.key);
});
test('CANCELING is not presented as stopped; explicit discard retains completed data',async()=>{
  const output=[];await run('import-cancel',[id],{},async()=>({result:{state:'CANCELING'}}),{write:v=>output.push(v)});
  assert.match(output.join(''),/正在取消/);assert.match(output.join(''),/临时文件仍保留/);
  await run('import-discard',[id],{},async(op,args)=>{assert.equal(op,'cloud.import.discard');assert.equal(args.operationId,id);return {result:{discarded:true}};},{write:v=>output.push(v)});
  assert.match(output.join(''),/已完成的个人 \/data2 文件保留/);
});
test('only HTTPS stopped tasks have replacement controls; active tasks cannot be discarded',()=>{
  const html=importRows([{operationId:id,path:'<img src=x onerror=alert(1)>',state:'CANCELING',sourceKind:'https',canResume:true,canDiscard:true}]);
  assert.match(html,/正在取消/);assert.match(html,/临时文件仍保留/);assert.doesNotMatch(html,/data-import-(resume|replace|discard)=|<img/);
  assert.match(importRows([{operationId:id,state:'PAUSED',sourceKind:'https',canResume:true}]),/data-import-replace=/);
  assert.doesNotMatch(importRows([{operationId:id,state:'PAUSED',sourceKind:'aliyun',canResume:true}]),/data-import-replace=/);
  assert.match(importRows([{operationId:id,state:'READY'}]),/data-import-discard=/);
});
