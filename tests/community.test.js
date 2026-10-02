import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {installCommunity,communityCall,COMMUNITY_LIMITS} from '../community.mjs';
import {PortalService} from '../portal-service.mjs';
import {createPortalServer} from '../portal-server.mjs';

const actors={admin:{userId:'admin-id',username:'admin',role:'admin'},alice:{userId:'alice-id',username:'alice',role:'member'},bob:{userId:'bob-id',username:'bob',role:'member'}};
function fixture(t){
  const service={db:new DatabaseSync(':memory:'),store:{users:Object.values(actors).map(a=>({id:a.userId,name:a.username,username:a.username,role:a.role,enabled:true,password:'NEVER_EXPOSE',limits:{private:'NEVER_EXPOSE'}}))},audits:[],audit(...args){this.audits.push(args);}};
  installCommunity(service);t.after(()=>service.db.close());
  const call=(operation,args={},actor='alice')=>communityCall(service,actors[actor],`community.${operation}`,args);
  const post=(args={},actor='alice')=>call('posts.create',{key:randomUUID(),kind:'feedback',title:'一个反馈',body:'本地纯测试',...args},actor).post;
  return {service,db:service.db,call,post};
}
const fails=(status)=>error=>error.status===status;

test('community info has explicit bounds and only small public author fields are exposed',t=>{
  const f=fixture(t),info=f.call('info');assert.equal(info.enabled,true);assert.equal(info.limits.chat,5000);assert.equal(info.limits.retentionDays,30);
  const post=f.post();assert.deepEqual(post.author,{id:'alice-id',name:'alice',username:'alice'});assert.equal(post.canEdit,true);assert.equal(post.canModerate,false);assert.equal(post.revision,1);assert.equal(post.commentCount,0);
  const other=f.call('posts.get',{id:post.id},'bob').post;assert.equal(other.canEdit,false);assert.equal(other.canDelete,false);
  assert.equal(JSON.stringify(f.call('posts.list')).includes('NEVER_EXPOSE'),false);
});

test('roles, ownership and all create identity injection are enforced server-side',t=>{
  const f=fixture(t),post=f.post(),comment=f.call('comments.create',{postId:post.id,key:randomUUID(),body:'回复'}).comment,message=f.call('chat.send',{key:randomUUID(),body:'你好'}).message;
  for(const [prefix,row] of [['comments',comment],['chat',message],['posts',post]]){
    assert.throws(()=>f.call(`${prefix}.update`,{id:row.id,revision:1,body:'改写'},'bob'),fails(403));
    assert.throws(()=>f.call(`${prefix}.delete`,{id:row.id,revision:1},'bob'),fails(403));
    assert.throws(()=>f.call(`${prefix}.update`,{id:row.id,revision:1,body:'管理员改写'},'admin'),fails(403));
    assert.equal(f.call(`${prefix}.delete`,{id:row.id,revision:1},'admin').deleted,true);
  }
  for(const extra of [{userId:'admin-id'},{author:{id:'admin-id'}},{role:'admin'},{createdAt:'2020-01-01'},{html:'<b>x</b>'},{source:'/etc/passwd'},{url:'https://example.invalid'}])assert.throws(()=>f.call('chat.send',{key:randomUUID(),body:'hello',...extra}),fails(400));
});

test('announcements are administrator-only, pinned ahead of recent posts, and feedback status is admin-only',t=>{
  const f=fixture(t);assert.throws(()=>f.post({kind:'announcement'}),fails(403));
  let announcement=f.post({kind:'announcement',announcementType:'maintenance'},'admin');
  assert.equal(announcement.announcementType,'maintenance');assert.equal(announcement.status,'open');
  announcement=f.call('posts.update',{id:announcement.id,revision:1,pinned:true},'admin').post;
  const feedback=f.post(),discussion=f.post({kind:'discussion'});
  assert.equal(f.call('posts.list').posts[0].id,announcement.id);
  for(const args of [{status:'resolved'},{pinned:true},{announcementType:'outage'}])assert.throws(()=>f.call('posts.update',{id:feedback.id,revision:1,...args}),fails(403));
  assert.equal(f.call('posts.update',{id:feedback.id,revision:1,status:'investigating'},'admin').post.status,'investigating');
  assert.throws(()=>f.call('posts.update',{id:discussion.id,revision:1,status:'closed'},'admin'),fails(400));
  assert.throws(()=>f.call('posts.update',{id:feedback.id,revision:2,pinned:true},'admin'),fails(400));
  assert.throws(()=>f.call('posts.delete',{id:announcement.id,revision:2}),fails(403));
});

test('announcement publish is atomic, retry-safe, and editable by fellow admins only',t=>{
  const f=fixture(t),args={key:randomUUID(),kind:'announcement',title:'发布更新',body:'已验收能力',pinned:true};
  const first=f.call('posts.create',args,'admin');assert.equal(first.post.pinned,true);assert.equal(first.post.revision,1);
  assert.equal(f.call('posts.create',args,'admin').post.id,first.post.id);
  assert.equal(f.call('posts.create',args,'admin').duplicate,true);
  assert.throws(()=>f.call('posts.create',{...args,pinned:false},'admin'),fails(409));
  assert.throws(()=>f.call('posts.create',{...args,key:randomUUID()}),fails(403));
  assert.throws(()=>f.post({pinned:false}),fails(400));
  const editor={userId:'editor',username:'editor',role:'admin'};f.service.store.users.push({id:'editor',username:'editor',role:'admin',enabled:true});
  const call=(op,body)=>communityCall(f.service,editor,'community.'+op,body);
  assert.equal(call('posts.get',{id:first.post.id}).post.canEdit,true);
  const updated=call('posts.update',{id:first.post.id,revision:1,body:'管理员共同维护的公告'}).post;assert.equal(updated.revision,2);assert.equal(updated.author.id,'admin-id');
  assert.throws(()=>call('posts.update',{id:updated.id,revision:1,body:'过期修改'}),fails(409));
  assert.throws(()=>f.call('posts.update',{id:updated.id,revision:2,body:'成员改写'}),fails(403));
  const memberPost=f.post();assert.throws(()=>call('posts.update',{id:memberPost.id,revision:1,body:'改写成员'}),fails(403));
  // The original create key remains valid after another admin edited the post.
  assert.equal(f.call('posts.create',args,'admin').post.body,updated.body);
});

test('pinned announcement capacity refusal rolls back post and receipt together',t=>{
  const f=fixture(t),now=Date.now();
  const insert=f.db.prepare("INSERT INTO community_posts(author_id,kind,title,body,pinned,created_at,updated_at) VALUES('admin-id','announcement','已有公告','正文',1,?,?)");
  for(let i=0;i<20;i++)insert.run(now,now);
  const args={key:randomUUID(),kind:'announcement',title:'新公告',body:'正文',pinned:true};
  assert.throws(()=>f.call('posts.create',args,'admin'),fails(409));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM community_posts').get().n,20);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM community_keys WHERE client_key=?').get(args.key).n,0);
  f.db.exec('UPDATE community_posts SET pinned=0 WHERE id=1');
  assert.equal(f.call('posts.create',args,'admin').post.pinned,true);
});

test('explicit pinned false keeps legacy post retry digest compatible',t=>{
  const f=fixture(t),args={key:randomUUID(),kind:'announcement',title:'兼容公告',body:'正文'};
  const first=f.call('posts.create',args,'admin');
  assert.equal(f.call('posts.create',{...args,pinned:false},'admin').post.id,first.post.id);
  assert(f.call('info').capabilities.includes('announcement-publish-v1'));
});

test('normal content edits require author and matching integer revision; stale updates cannot overwrite',t=>{
  const f=fixture(t),post=f.post();
  const updated=f.call('posts.update',{id:post.id,revision:1,title:'修改后',body:'正文2'}).post;assert.equal(updated.revision,2);assert.equal(updated.body,'正文2');
  for(const revision of [undefined,'2',null,0,1.5])assert.throws(()=>f.call('posts.update',{id:post.id,revision,body:'错误'}),fails(400));
  assert.throws(()=>f.call('posts.update',{id:post.id,revision:1,body:'过期'}),fails(409));assert.throws(()=>f.call('posts.delete',{id:post.id,revision:1}),fails(409));
  assert.equal(f.call('posts.get',{id:post.id}).post.body,'正文2');
  const comment=f.call('comments.create',{postId:post.id,key:randomUUID(),body:'回复'}).comment;
  assert.equal(f.call('comments.update',{id:comment.id,revision:1,body:'新回复'}).comment.revision,2);
  const message=f.call('chat.send',{key:randomUUID(),body:'聊天'}).message;
  assert.equal(f.call('chat.update',{id:message.id,revision:1,body:'新聊天'}).message.revision,2);
});

test('create keys deduplicate normalized retries, conflict on changed payload/operation and remain owner scoped',t=>{
  const f=fixture(t),key=randomUUID(),args={key,body:'原消息\r\n第二行'};
  const first=f.call('chat.send',args);assert.equal(first.duplicate,false);
  assert.equal(f.call('chat.send',{...args,body:'原消息\n第二行'}).message.id,first.message.id);
  assert.equal(f.call('chat.send',args).duplicate,true);
  assert.throws(()=>f.call('chat.send',{...args,body:'不同内容'}),fails(409));
  assert.throws(()=>f.call('posts.create',{key,kind:'feedback',title:'不能重用',body:args.body}),fails(409));
  assert.notEqual(f.call('chat.send',args,'bob').message.id,first.message.id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM community_chat').get().n,2);
});

test('deleting a post removes children, but retries of both keys cannot resurrect deleted content',t=>{
  const f=fixture(t),key=randomUUID(),args={key,kind:'feedback',title:'短标题',body:'正文'},post=f.call('posts.create',args).post;
  const commentArgs={key:randomUUID(),postId:post.id,body:'回复'},comment=f.call('comments.create',commentArgs).comment;
  f.call('posts.delete',{id:post.id,revision:1});
  assert.throws(()=>f.call('posts.get',{id:post.id}),fails(404));assert.throws(()=>f.call('comments.list',{postId:post.id}),fails(404));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM community_comments').get().n,0);
  for(const [op,input,type,originalId] of [['posts.create',args,'post',post.id],['comments.create',commentArgs,'comment',comment.id]]){const retry=f.call(op,input);assert.equal(retry.duplicate,true);assert.equal(retry.deleted,true);assert.equal(retry[type],null);assert.equal(retry.id,originalId);}
  assert.throws(()=>f.call('comments.create',{...commentArgs,key:randomUUID()}),fails(404));
});

test('post cursor pages are deterministic, filter bound, include pins and do not repeat or skip stable rows',t=>{
  const f=fixture(t),a=f.post({kind:'announcement'},'admin');f.call('posts.update',{id:a.id,revision:1,pinned:true},'admin');
  f.post();f.post({kind:'discussion'});f.post();
  let cursor,ids=[];do{const page=f.call('posts.list',{limit:1,...(cursor?{cursor}:{})});ids.push(...page.posts.map(p=>p.id));cursor=page.nextCursor;}while(cursor);
  assert.equal(ids[0],a.id);assert.equal(new Set(ids).size,4);assert.equal(ids.length,4);
  const filtered=f.call('posts.list',{kind:'feedback',limit:1});assert.ok(filtered.nextCursor);assert.equal(f.call('posts.list',{kind:'feedback',limit:1,cursor:filtered.nextCursor}).posts.length,1);
  assert.throws(()=>f.call('posts.list',{kind:'discussion',cursor:filtered.nextCursor}),fails(400));
  for(const cursor of [null,0,'../../x','eA','a'.repeat(513)])assert.throws(()=>f.call('posts.list',{cursor}),fails(400));
});

test('comments page ascending by keyset and remain isolated per post',t=>{
  const f=fixture(t),a=f.post(),b=f.post(),ids=[];
  for(let n=0;n<4;n++)ids.push(f.call('comments.create',{postId:a.id,key:randomUUID(),body:`reply ${n}`}).comment.id);
  f.call('comments.create',{postId:b.id,key:randomUUID(),body:'other'});
  const first=f.call('comments.list',{postId:a.id,limit:2}),second=f.call('comments.list',{postId:a.id,limit:2,cursor:first.nextCursor});
  assert.deepEqual([...first.comments,...second.comments].map(x=>x.id),ids);assert.equal(second.nextCursor,null);assert.equal(f.call('posts.get',{id:a.id}).post.commentCount,4);
});

test('chat supports recent tail, older pages and complete forward polling without losing a large batch',t=>{
  const f=fixture(t),ids=[];for(let n=0;n<8;n++)ids.push(f.call('chat.send',{key:randomUUID(),body:`line ${n}`}).message.id);
  const tail=f.call('chat.list',{limit:3});assert.deepEqual(tail.messages.map(x=>x.id),ids.slice(-3));assert.equal(tail.nextCursor,ids[5]);assert.equal(tail.latestCursor,ids[7]);assert.equal(tail.hasMore,true);
  const older=f.call('chat.list',{before:tail.nextCursor,limit:3});assert.deepEqual(older.messages.map(x=>x.id),ids.slice(2,5));
  const initial=f.call('chat.list',{after:ids[0],limit:3}),next=f.call('chat.list',{after:initial.nextCursor,limit:3}),last=f.call('chat.list',{after:next.nextCursor,limit:3});
  assert.deepEqual([...initial.messages,...next.messages,...last.messages].map(x=>x.id),ids.slice(1));assert.equal(last.hasMore,false);
  assert.throws(()=>f.call('chat.list',{before:'1',after:'2'}),fails(400));
});

test('plain text is literal, no link fetching or HTML execution; body and UTF8/control limits fail closed',t=>{
  const f=fixture(t),body='<script>alert(1)</script> [secret](http://169.254.169.254/metadata) https://example.invalid';
  t.mock.method(globalThis,'fetch',()=>{throw Error('Community must never fetch a user URL');});
  assert.equal(f.call('chat.send',{key:randomUUID(),body}).message.body,body);
  for(const body of ['', '  ',null,0,{},[], 'a\0b','a\x1bb','\ud800','x'.repeat(2001),'😀'.repeat(1600)])assert.throws(()=>f.call('chat.send',{key:randomUUID(),body}),fails(400));
  for(const key of [undefined,null,{},'x','../../secret'])assert.throws(()=>f.call('chat.send',{key,body:'ok'}),fails(400));
  for(const limit of [null,0,101,1.5,'10',true])assert.throws(()=>f.call('chat.list',{limit}),fails(400));
  for(const id of [null,1,'0','01','1 OR 1=1','9007199254740993'])assert.throws(()=>f.call('posts.get',{id}),fails(400));
  assert.throws(()=>f.call('posts.create',{key:randomUUID(),kind:'feedback',title:'x'.repeat(121),body:'ok'}),fails(400));
  assert.throws(()=>f.call('info',{extra:true}),fails(400));assert.throws(()=>f.call('unknown'),fails(400));
});

test('Unicode codepoint and explicit UTF8 byte limits both apply at their exact advertised boundaries',t=>{
  const f=fixture(t),limits=f.call('info').limits;
  for(const body of ['a'.repeat(2000),'中'.repeat(2000),'😀'.repeat(1500)]){assert.ok([...body].length<=limits.chatBody);assert.ok(Buffer.byteLength(body)<=limits.chatBodyBytes);assert.equal(f.call('chat.send',{key:randomUUID(),body}).message.body,body);}
  for(const body of ['a'.repeat(2001),'中'.repeat(2001),'😀'.repeat(1501)])assert.throws(()=>f.call('chat.send',{key:randomUUID(),body}),fails(400));
  assert.equal(f.post({title:'😀'.repeat(90)}).title,'😀'.repeat(90));assert.throws(()=>f.post({title:'😀'.repeat(91)}),fails(400));
});

test('per-author durable rate limits reject spam, do not charge retries and reset after the server window',t=>{
  const f=fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);
  const args={key:randomUUID(),body:'重复请求不计费'};f.call('chat.send',args);for(let n=0;n<25;n++)assert.equal(f.call('chat.send',args).duplicate,true);
  for(let n=1;n<20;n++)f.call('chat.send',{key:randomUUID(),body:`message ${n}`});
  assert.throws(()=>f.call('chat.send',{key:randomUUID(),body:'rate limited'}),fails(429));assert.equal(f.call('chat.send',{key:randomUUID(),body:'another author'},'bob').duplicate,false);
  now+=60001;assert.equal(f.call('chat.send',{key:randomUUID(),body:'new window'}).duplicate,false);
  f.post();f.post();f.post();assert.throws(()=>f.post(),fails(429));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM community_rate').get().n<=6,true);
});

test('global author write budget covers edits and deletes, including administrator actions',t=>{
  const f=fixture(t),post=f.post();let revision=1;
  for(let n=1;n<60;n++)revision=f.call('posts.update',{id:post.id,revision,body:`edit ${n}`}).post.revision;
  assert.throws(()=>f.call('posts.delete',{id:post.id,revision}),fails(429));assert.equal(f.call('posts.get',{id:post.id}).post.revision,60);
});

test('chat retention is bounded by count and age; evicted keys still return non-resurrecting receipts',t=>{
  const f=fixture(t),now=Date.now(),args={key:randomUUID(),body:'oldest retained key'},first=f.call('chat.send',args).message;
  const insert=f.db.prepare('INSERT INTO community_chat(author_id,body,created_at,updated_at) VALUES(?,?,?,?)');
  f.db.exec('BEGIN');for(let i=0;i<COMMUNITY_LIMITS.chat;i++)insert.run('bob-id',`seed ${i}`,now,now);f.db.exec('COMMIT');
  f.call('chat.send',{key:randomUUID(),body:'trigger bounded trim'});assert.equal(f.db.prepare('SELECT count(*) AS n FROM community_chat').get().n,5000);
  const retry=f.call('chat.send',args);assert.equal(retry.deleted,true);assert.equal(retry.id,first.id);assert.equal(retry.message,null);
  f.db.prepare('UPDATE community_chat SET created_at=?').run(now-31*86400000);assert.equal(f.call('chat.list').messages.length,0);
  f.call('chat.send',{key:randomUUID(),body:'new day'});assert.equal(f.db.prepare('SELECT count(*) AS n FROM community_chat').get().n,1);
});

test('forum and idempotency capacity limits are hard failures and do not discard existing records',t=>{
  const f=fixture(t),now=Date.now();
  f.db.prepare("WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<?) INSERT INTO community_posts(author_id,kind,title,body,created_at,updated_at) SELECT 'alice-id','feedback','seed','seed',?,? FROM seq").run(COMMUNITY_LIMITS.posts,now,now);
  assert.throws(()=>f.post(),fails(507));assert.equal(f.db.prepare('SELECT count(*) AS n FROM community_posts').get().n,10000);
  f.db.prepare("WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<?) INSERT INTO community_comments(post_id,author_id,body,created_at,updated_at) SELECT 1,'alice-id','seed',?,? FROM seq").run(COMMUNITY_LIMITS.comments,now,now);
  assert.throws(()=>f.call('comments.create',{key:randomUUID(),postId:'1',body:'over limit'}),fails(507));
  f.db.prepare("WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<?) INSERT INTO community_keys(author_id,client_key,operation,digest,entity_id,created_at) SELECT 'alice-id','seed-'||x,'seed','seed',1,? FROM seq").run(COMMUNITY_LIMITS.keys,now);
  assert.throws(()=>f.call('chat.send',{key:randomUUID(),body:'over ledger limit'}),fails(507));assert.equal(f.db.prepare('SELECT count(*) AS n FROM community_chat').get().n,0);
  f.db.prepare('UPDATE community_keys SET created_at=?').run(now-31*86400000);assert.equal(f.call('chat.send',{key:randomUUID(),body:'expired ledger reclaimed'}).duplicate,false);
});

test('failed durable audit rolls back content, dedup key and rate charge in the same transaction',t=>{
  const f=fixture(t);f.service.audit=()=>{throw Error('simulated disk failure');};
  assert.throws(()=>f.call('chat.send',{key:randomUUID(),body:'must not persist'}),/simulated disk failure/);
  for(const table of ['community_chat','community_keys','community_rate'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
});

test('live account enable/role checks close stale privileged calls and deleted usernames cannot inherit ownership',t=>{
  const f=fixture(t),post=f.post();f.service.store.users.find(u=>u.id==='alice-id').enabled=false;assert.throws(()=>f.call('posts.list'),fails(403));
  f.service.store.users.find(u=>u.id==='admin-id').role='member';assert.throws(()=>f.call('posts.create',{key:randomUUID(),kind:'announcement',title:'denied',body:'denied'},'admin'),fails(401));
  f.service.store.users=f.service.store.users.filter(u=>u.id!=='alice-id');assert.throws(()=>f.call('posts.list'),fails(403));
  const viewed=f.call('posts.get',{id:post.id},'bob').post;assert.equal(viewed.author.name,'已删除账号');assert.equal(viewed.author.username,null);assert.equal(viewed.canEdit,false);
});

async function portalFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-community-')),database=join(dir,'portal.sqlite'),bootstrap=join(dir,'bootstrap.json'),password='Local-Community-Test-Password!';await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  let service=await PortalService.open(database,bootstrap),admin=await service.login('admin',password);
  const account=(await service.invoke(admin.token,'users.create',{username:'community-user',password})).result;let member=await service.login('community-user',password);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  return {get service(){return service},get admin(){return admin},get member(){return member},account,reopen:async()=>{service.close();service=await PortalService.open(database);admin=await service.login('admin',password);member=await service.login('community-user',password);}};
}

test('authenticated PortalService integration persists separate tables and never rewrites portal_state for chat',async t=>{
  const f=await portalFixture(t),args={key:randomUUID(),body:'PERSISTED-COMMUNITY-TEXT'},before=f.service.db.prepare('SELECT data FROM portal_state').get().data;
  for(const operation of ['community.info','community.posts.list','community.chat.list','community.chat.send'])await assert.rejects(f.service.invoke('invalid',operation,args),fails(401));
  const response=await f.service.invoke(f.member.token,'community.chat.send',args);assert.equal(response.state,undefined);assert.equal(response.result.message.author.id,f.account.id);assert.equal(response.principal.userId,f.account.id);
  assert.equal(f.service.db.prepare('SELECT data FROM portal_state').get().data,before);
  assert.equal(JSON.stringify(f.service.db.prepare('SELECT * FROM audit').all()).includes(args.body),false);
  const oldToken=f.member.token;await f.reopen();await assert.rejects(f.service.invoke(oldToken,'community.chat.list'),fails(401));
  const replay=await f.service.invoke(f.member.token,'community.chat.send',args);assert.equal(replay.result.duplicate,true);assert.equal(replay.result.message.id,response.result.message.id);
  const persistedAudit=f.service.db.prepare("SELECT actor,subject,outcome FROM audit WHERE operation='community.chat.send'").all();assert.deepEqual(persistedAudit.map(row=>({...row})),[{actor:'community-user',subject:response.result.message.id,outcome:'ok'}]);
  assert.equal((await f.service.invoke(f.member.token,'community.chat.list')).result.messages[0].body,args.body);
  await f.service.invoke(f.admin.token,'users.enabled',{userId:f.account.id,enabled:false});await assert.rejects(f.service.invoke(f.member.token,'community.chat.send',{key:randomUUID(),body:'denied'}),fails(401));
});

test('rate counters survive process reopen and concurrent requests with one key create only once',async t=>{
  const f=await portalFixture(t),args={key:randomUUID(),body:'ONE-COMMIT'};
  const replies=await Promise.all(Array.from({length:8},()=>f.service.invoke(f.member.token,'community.chat.send',args)));assert.equal(new Set(replies.map(r=>r.result.message.id)).size,1);assert.equal(replies.filter(r=>!r.result.duplicate).length,1);
  for(let n=1;n<20;n++)await f.service.invoke(f.member.token,'community.chat.send',{key:randomUUID(),body:`seed ${n}`});
  await f.reopen();await assert.rejects(f.service.invoke(f.member.token,'community.chat.send',{key:randomUUID(),body:'restart cannot reset rate'}),fails(429));
});

test('real local HTTP community calls retain cookie origin and bearer authentication boundaries',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-community-http-')),database=join(dir,'portal.sqlite'),bootstrap=join(dir,'bootstrap.json'),password='Local-HTTP-Community-Test!',origin='https://community.example.test';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));let server;
  try{
    const opened=await createPortalServer({database,bootstrap,origin});server=opened.server;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const post=(path,body,headers={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{Host:'community.example.test','Content-Type':'application/json',...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));});
    const call=(operation,args={},headers={})=>post('/api/call',{operation,args},headers);
    assert.equal((await call('community.info')).status,401);
    const login=await post('/api/login',{username:'admin',password,client:'browser'},{Origin:origin});assert.equal(login.status,200);assert.equal(login.data.token,undefined);
    const cookie=login.headers['set-cookie'][0].split(';')[0];assert.equal((await call('community.info',{}, {Cookie:cookie})).status,403);
    const headers={Cookie:cookie,Origin:origin},info=await call('community.info',{},headers);assert.equal(info.status,200);assert.equal(info.data.result.enabled,true);assert.equal(info.data.state,undefined);
    const announcement=await call('community.posts.create',{key:randomUUID(),kind:'announcement',announcementType:'outage',title:'维护窗口',body:'测试公告'},headers);assert.equal(announcement.status,200);assert.equal(announcement.data.result.post.announcementType,'outage');
    await call('users.create',{username:'http-member',password},headers);const member=await post('/api/login',{username:'http-member',password});assert.equal(member.status,200);
    const memberHeaders={Authorization:`Bearer ${member.data.token}`};assert.equal((await call('community.posts.create',{key:randomUUID(),kind:'announcement',title:'越权',body:'越权'},memberHeaders)).status,403);
    const message=await call('community.chat.send',{key:randomUUID(),body:'<img src=x onerror=alert(1)>'},memberHeaders);assert.equal(message.status,200);assert.equal(message.data.result.message.body,'<img src=x onerror=alert(1)>');assert.equal(message.headers['content-type'],'application/json; charset=utf-8');
    assert.deepEqual(Object.keys(message.data.result.message.author).sort(),['id','name','username']);assert.equal((await call('community.chat.list',{},memberHeaders)).data.result.messages.length,1);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
