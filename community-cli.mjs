import {open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

export const communityHelp=`gpuctl community posts [--kind feedback|discussion|announcement]
gpuctl community show ID
gpuctl community post --title TITLE --body-file FILE [--kind feedback|discussion|announcement] [--pin] [--key UUID]
gpuctl community edit ID --revision N [--title TITLE] [--body-file FILE] [--status open|investigating|resolved|closed]
gpuctl community pin ID on|off --revision N
gpuctl community comment ID --body TEXT [--key UUID]
gpuctl community comments ID
gpuctl community chat [--body TEXT] [--key UUID]
--status edits feedback posts only and requires an administrator.
Use --json for scripting. Uncertain submission: reuse the same --key and content within 30 days.`;
const common=['url','session-file','json','machines','datasets'];
const fail=message=>{throw Error(message);};
const visible=value=>String(value??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>c==='\n'?c:'\\u{'+c.codePointAt(0).toString(16).padStart(4,'0')+'}');
export const communityJSON=value=>JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>c.split('').map(unit=>'\\u'+unit.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
function integer(value,name,max=Number.MAX_SAFE_INTEGER){if(!/^[1-9][0-9]*$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)>max)fail(`${name} must be a positive integer${max<Number.MAX_SAFE_INTEGER?' up to '+max:''}.`);return Number(value);}
function content(value,max,label){if(typeof value!=='string'||!value.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(`${label} must be valid plain text.`);value=value.replace(/\r\n?/g,'\n').trim();if(!value||[...value].length>max||Buffer.byteLength(value)>max*3)fail(`${label} exceeds its limit (${max} characters / ${max*3} UTF-8 bytes) or is empty.`);return value;}
async function body(options,max){
  if((options.body!==undefined)===(options['body-file']!==undefined))fail('Use exactly one --body TEXT or --body-file FILE.');
  if(options.body!==undefined)return content(options.body,max,'Body');
  const file=await open(options['body-file'],'r');
  try{const before=await file.stat();if(!before.isFile()||before.size>max*3)fail('Body file must be a regular UTF-8 file within the body size limit.');const buffer=Buffer.alloc(max*3+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);const after=await file.stat();if(bytesRead!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)fail('Body file changed while reading; retry after saving it.');return content(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)),max,'Body');}
  finally{await file.close();}
}

// call has the same envelope as the main CLI: await call(op,args) -> {result}.
// No service credentials, direct fetch, shell, or automatic second submission.
export async function runCommunityCommand({positionals,options={},training=[],call,onKey=key=>process.stderr.write(`Submission key: ${key}; reuse --key with unchanged content within 30 days after an uncertain response.\n`)}){
  if(positionals[0]!=='community'||training.length)fail(communityHelp);
  if(options.machines?.length||options.datasets?.length)fail('Community commands do not take a machine or dataset.');
  const command=positionals[1]||'posts',tail=positionals.slice(2);
  const spec={posts:{n:0,opts:['kind','status','cursor','limit']},show:{n:1,opts:[]},post:{n:0,opts:['kind','title','body','body-file','pin','key','announcement-type']},edit:{n:1,opts:['revision','title','body','body-file','status']},pin:{n:2,opts:['revision']},comment:{n:1,opts:['body','body-file','key']},comments:{n:1,opts:['cursor','limit']},chat:{n:0,opts:['body','body-file','key','cursor','limit']}}[command];
  if(!spec||tail.length!==spec.n||Object.keys(options).some(k=>![...common,...spec.opts].includes(k)))fail(communityHelp);
  const request=async(op,args)=>(await call('community.'+op,args)).result;
  const paging=()=>({...((options.limit!==undefined)?{limit:integer(options.limit,'--limit',command==='posts'?50:100)}:{}),...(options.cursor?{cursor:options.cursor}:{})});
  const postId=()=>{integer(tail[0],'ID');return String(tail[0]);};
  const create=async(op,payload)=>{
    const key=options.key||randomUUID();if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key))fail('--key must be a UUID.');
    // Print before the network call, so even a lost response leaves a retry key.
    onKey(key);return {...await request(op,{...payload,key}),submissionKey:key};
  };
  if(command==='posts')return request('posts.list',{...paging(),...(options.kind?{kind:options.kind}:{}),...(options.status?{status:options.status}:{})});
  if(command==='show')return request('posts.get',{id:postId()});
  if(command==='comments')return request('comments.list',{postId:postId(),...paging()});
  if(command==='post'){
    const kind=options.kind||'feedback';if(!['feedback','discussion','announcement'].includes(kind))fail('Use --kind feedback|discussion|announcement.');
    if(kind!=='announcement'&&(options.pin!==undefined||options['announcement-type']!==undefined))fail('--pin and --announcement-type require --kind announcement.');
    const title=content(options.title,120,'Title'),text=await body(options,8000);
    if(options.pin||options['announcement-type']){const info=await request('info',{});if(!info.capabilities?.includes('announcement-publish-v1'))fail('The server must be upgraded before publishing a pinned announcement.');}
    return create('posts.create',{kind,title,body:text,...(kind==='announcement'?{announcementType:options['announcement-type']||'notice',...(options.pin?{pinned:true}:{})}:{})});
  }
  if(command==='edit'){
    if(options.title===undefined&&options.body===undefined&&options['body-file']===undefined&&options.status===undefined)fail('Nothing to edit. Use --title, --body-file or --status.');
    if(options.status!==undefined&&!['open','investigating','resolved','closed'].includes(options.status))fail('Use --status open|investigating|resolved|closed for feedback posts.');
    return request('posts.update',{id:postId(),revision:integer(options.revision,'--revision'),...(options.title===undefined?{}:{title:content(options.title,120,'Title')}),...(options.body===undefined&&options['body-file']===undefined?{}:{body:await body(options,8000)}),...(options.status===undefined?{}:{status:options.status})});
  }
  if(command==='pin'){if(!['on','off'].includes(tail[1]))fail('Use community pin ID on|off --revision N.');return request('posts.update',{id:postId(),revision:integer(options.revision,'--revision'),pinned:tail[1]==='on'});}
  if(command==='comment')return create('comments.create',{postId:postId(),body:await body(options,4000)});
  if(options.body!==undefined||options['body-file']!==undefined){if(options.cursor||options.limit)fail('Chat send cannot be combined with pagination.');return create('chat.send',{body:await body(options,2000)});}
  if(options.key)fail('--key is only used when sending a message.');
  const page=paging();return request('chat.list',{...(page.limit?{limit:page.limit}:{}),...(page.cursor?{before:page.cursor}:{})});
}

export function formatCommunityResult(result){
  const row=item=>`${item.id} · ${item.kind||'消息'}${item.pinned?' · 置顶':''}${item.revision?' · revision '+item.revision:''}${item.title?' · '+item.title:''}\n${item.body||''}`;
  if(result.deleted)return visible(`内容 ${result.id} 已删除或过期；没有重新发布。`);
  const items=result.posts||result.comments||result.messages||[result.post||result.comment||result.message].filter(Boolean);
  return visible((items.length?items.map(row).join('\n\n'):'暂无内容。')+(result.duplicate?'\n已确认此前提交，未重复发布。':'')+(result.nextCursor?'\n下一页：--cursor '+result.nextCursor:'')+(result.submissionKey?'\n提交键：'+result.submissionKey:''));
}
