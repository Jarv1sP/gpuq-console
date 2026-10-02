import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runCommunityCommand,formatCommunityResult,communityJSON} from '../community-cli.mjs';
const key='f0000000-0000-4000-8000-000000000001';
const invoke=(args,options,call,extra={})=>runCommunityCommand({positionals:['community',...args],options,call,onKey:()=>{},...extra});

test('post prints the retry key before network, reuses it and retains response fields',async()=>{
  const sequence=[],call=async(op,args)=>{sequence.push(op);assert.equal(args.key,key);assert.equal(args.kind,'feedback');assert.equal(args.body,'正文\n二行');return {result:{post:{id:'1'},duplicate:true}};};
  const result=await invoke(['post'],{title:'反馈',body:'正文\r\n二行',key},call,{onKey:value=>sequence.push(value)});
  assert.deepEqual(sequence,[key,'community.posts.create']);assert.equal(result.submissionKey,key);assert.equal(result.duplicate,true);
});
test('network error is not retried or replaced with a new key',async()=>{
  let calls=0,saved;await assert.rejects(()=>invoke(['post'],{title:'反馈',body:'正文'},async()=>{calls++;throw Error('offline');},{onKey:key=>saved=key}),/offline/);
  assert.equal(calls,1);assert.match(saved,/^[a-f0-9-]{36}$/);
});
test('announcement supports bounded UTF-8 file and pinned create in one write',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'community-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'公告.md');await writeFile(path,'已完成的更新。\n');const writes=[];
  await invoke(['post'],{kind:'announcement',title:'更新公告','body-file':path,pin:true,key},async(op,args)=>{if(op==='community.info')return {result:{capabilities:['announcement-publish-v1']}};writes.push([op,args]);return {result:{post:{id:'1'}}};});
  assert.equal(writes.length,1);assert.equal(writes[0][0],'community.posts.create');assert.equal(writes[0][1].pinned,true);assert.equal(writes[0][1].body,'已完成的更新。');
  await writeFile(path,Buffer.alloc(24001,97));await assert.rejects(()=>invoke(['post'],{title:'反馈','body-file':path},()=>assert.fail('must not call API')),/size limit/);
  await writeFile(path,Buffer.from([0xff]));await assert.rejects(()=>invoke(['post'],{title:'反馈','body-file':path},()=>assert.fail('must not call API')));
});
test('unsafe or unsupported arguments fail before any write',async()=>{
  const call=()=>assert.fail('must not call API');
  for(const options of [{title:'t',body:'x',pin:true},{title:'t',body:'x','body-file':'somewhere'},{title:'t',body:'x',key:'bad'},{title:'t',body:'x',as:'admin'},{title:'t',body:'\u001b[2J'}])await assert.rejects(()=>invoke(['post'],options,call));
  await assert.rejects(()=>invoke(['pin','1','on'],{},call),/revision/);
  await assert.rejects(()=>invoke(['post'],{kind:'announcement',title:'t',body:'x',pin:true},async()=>({result:{capabilities:[]}})),/upgraded/);
});
test('read, comments, chat and revision edits map to authenticated APIs only',async()=>{
  const seen=[],call=async(op,args)=>{seen.push([op,args]);return {result:{}};};
  await invoke(['posts'],{kind:'discussion',limit:'20',cursor:'cursor'},call);
  await invoke(['show','2'],{},call);await invoke(['comments','2'],{},call);
  await invoke(['comment','2'],{body:'同意',key},call);await invoke(['chat'],{body:'消息',key},call);
  await invoke(['chat'],{cursor:'6',limit:'50'},call);await invoke(['edit','2'],{revision:'3',body:'更新'},call);
  await invoke(['pin','2','off'],{revision:'4'},call);
  assert.deepEqual(seen.map(x=>x[0]),['community.posts.list','community.posts.get','community.comments.list','community.comments.create','community.chat.send','community.chat.list','community.posts.update','community.posts.update']);
  assert.deepEqual(seen.at(-1)[1],{id:'2',revision:4,pinned:false});assert.deepEqual(seen[5][1],{before:'6',limit:50});
});
test('member content cannot inject terminal controls in human or JSON output',()=>{
  const result={post:{id:'1',kind:'feedback',title:'\u202eabc',body:'\u001b[2J\n文本\r覆盖'}};
  const printed=formatCommunityResult(result);assert(!printed.includes('\u001b'));assert(!printed.includes('\u202e'));assert(printed.includes('\\u{001b}'));
  assert.equal(JSON.parse(communityJSON(result)).post.body,result.post.body);assert(!communityJSON(result).includes('\u202e'));
});
