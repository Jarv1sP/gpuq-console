import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadWorkspaceFiles,workspacePath,workspaceEntriesHTML,dataWorkspaceHTML,publicationText} from '../dist/data-workspace.js';
import {terminalContext,terminalLaunchContext} from '../dist/terminal-ui.js';
const file=(name,size)=>{const blob=new Blob([new Uint8Array(size)]);Object.defineProperty(blob,'name',{value:name});return blob;};

test('data terminal is a distinct personal scope without project or ROOT inheritance',()=>{
  for(const role of ['admin','member'])assert.deepEqual(terminalLaunchContext({machine:'node-a',project:'experiment',entry:'data',role}),{machine:'node-a',hostAdmin:false,dataWorkspace:true});
  assert.throws(()=>terminalContext({machine:'node-a',dataWorkspace:true,project:'experiment'}),/混用/);
  assert.throws(()=>terminalContext({machine:'node-a',dataWorkspace:true,hostAdmin:true}),/混用/);
});

test('workspace paths reject traversal and only allow root for explicit browse/upload',()=>{
  assert.equal(workspacePath('.',{root:true}),'.');assert.equal(workspacePath('训练/a.zip'),'训练/a.zip');
  for(const path of ['.','/data2/a','../a','x/../a','x//a','x\\a','x\na',''])assert.throws(()=>workspacePath(path));
  assert.equal(workspacePath('汉'.repeat(85)),'汉'.repeat(85));assert.throws(()=>workspacePath('汉'.repeat(86)));
  assert.equal(workspacePath(['a'.repeat(255),'b'.repeat(255),'c'.repeat(255),'d'.repeat(255)].join('/')).length,1023);
  assert.throws(()=>workspacePath(['a'.repeat(255),'b'.repeat(255),'c'.repeat(255),'d'.repeat(255),'x'].join('/')));
});

test('raw uploads are bounded, ordered, acknowledge exact offsets and never unpack/publish',async()=>{
  const calls=[],progress=[];
  const result=await uploadWorkspaceFiles({machine:'node-a',files:[file('dataset.zip',2*1024**2+7),file('empty',0)],directory:'incoming',call:async(operation,args)=>{calls.push({operation,args});return {path:args.path,size:args.offset+Buffer.from(args.data,'base64').length};},onProgress:value=>progress.push(value)});
  assert.deepEqual(result,{files:2,bytes:2*1024**2+7});assert.equal(calls.length,4);
  assert.ok(calls.every(call=>call.operation==='datasets.workspace.put'&&Buffer.from(call.args.data,'base64').length<=1024**2));
  assert.deepEqual(calls.map(call=>call.args.offset),[0,1024**2,2*1024**2,0]);assert.ok(calls.every(call=>call.args.truncate===false));
  assert.equal(calls[0].args.path,'incoming/dataset.zip');assert.equal(progress.at(-1).bytes,result.bytes);
});

test('explicit overwrite truncates only the first chunk; ambiguous error is not retried',async()=>{
  const calls=[];await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('a.zip',2*1024**2+1)],overwrite:true,call:async(operation,args)=>{calls.push(args);if(args.offset)throw Error('response lost');return {path:args.path,size:1024**2};}}),/response lost/);
  assert.equal(calls.length,2);assert.deepEqual(calls.map(call=>call.truncate),[true,false]);
});

test('abort after durable put stops further chunks and suppresses success callbacks',async()=>{
  const controller=new AbortController();let calls=0,reports=0;
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('a.zip',2*1024**2)],signal:controller.signal,call:async(operation,args)=>{calls++;controller.abort();return {path:args.path,size:1024**2};},onProgress:()=>reports++}),/停止/);
  assert.equal(calls,1);assert.equal(reports,0);
});

test('inexact receipts, duplicate filenames and invalid names fail closed',async()=>{
  for(const receipt of [{path:'incoming/a',size:2},{path:'different',size:1},{}])await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('a',1)],call:async()=>receipt}),/确认/);
  for(const names of [['a','a'],['../a'],['sub/a']])await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:names.map(name=>file(name,1)),call:async()=>assert.fail('invalid input reached network')}));
});

test('all file sizes and fully joined paths are validated before the first upload',async()=>{
  let calls=0;const call=async()=>{calls++;assert.fail('invalid batch reached network');};
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('first',1),{name:'too-big.tar',size:100*1024**3+1}],call}),/100 GiB/);
  const directory=['a'.repeat(255),'b'.repeat(255),'c'.repeat(255),'d'.repeat(200)].join('/');
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',directory,files:[file('first',1),file('z'.repeat(255),1)],call}),/1024/);
  assert.equal(calls,0);
});

test('workspace list escapes server filenames, paths and sizes',()=>{
  const html=workspaceEntriesHTML({path:'.',entries:[{type:'directory',name:'" onclick="<bad>'},{type:'file',name:'<script>',size:10}]});
  assert.doesNotMatch(html,/<bad>|<script>|data-workspace-path=""/);assert.match(html,/&lt;script&gt;/);assert.match(dataWorkspaceHTML(),/不会自动解压/);assert.match(dataWorkspaceHTML(),/结束此机器上的所有数据终端/);
});

test('publication receipts report current readiness and require admin inspection for unknown outcomes',()=>{
  for(const state of ['NOT_READY','UNREGISTERED','UNAVAILABLE']){
    const text=publicationText({state,publicationState:'READY'});assert.doesNotMatch(text,/服务器正在|已发布：|可在下方选择/);
  }
  assert.match(publicationText({state:'NOT_READY'}),/副本.*不再就绪/);
  assert.match(publicationText({state:'UNREGISTERED'}),/登记已删除/);
  assert.match(publicationText({state:'UNAVAILABLE'}),/无权.*管理员/);
  assert.match(publicationText({state:'UNKNOWN'}),/暂不可编辑.*管理员.*不要重复发布/);
});
test('raw browser files require explicit relay consent above the shared 256 MiB boundary',async()=>{
  const selected=size=>({name:'data.zip',size,slice(){throw Error('read-started');}}),call=async()=>assert.fail('No network expected in size-only fixture');
  for(const allowRelay of [undefined,false,'true'])await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[selected(256*1024**2+1)],allowRelay,call}),/确认 VPS 中转/);
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[selected(256*1024**2)],call}),/read-started/);
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[selected(256*1024**2+1)],allowRelay:true,call}),/read-started/);
  assert.match(dataWorkspaceHTML(),/个人数据上传通道/);assert.match(dataWorkspaceHTML(),/data-workspace-relay-consent/);
});
