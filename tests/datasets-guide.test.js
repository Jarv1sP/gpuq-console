import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createServer} from '../server.mjs';
import {createPortalServer} from '../portal-server.mjs';
import {inline,renderMarkdown,parseGuide,guideTarget} from '../guide.mjs';

async function port(){const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const number=socket.address().port;await new Promise(r=>socket.close(r));return number;}
async function check(origin){
  const index=await fetch(origin+'/guide');assert.equal(index.status,200);assert.match(index.headers.get('content-type'),/^text\/html/);assert.equal(index.headers.get('x-content-type-options'),'nosniff');
  const landing=await index.text();assert.match(landing,/<h1>从准备，<br>到一次训练。<\/h1>/);assert.match(landing,/STARGATE/);assert.match(landing,/按功能查阅/);assert.doesNotMatch(landing,/guide\/admin|ADMIN_README/);
  for(const id of ['start','development','training','data','results','queue','troubleshooting']){
    const response=await fetch(origin+'/guide/'+id);assert.equal(response.status,200);
    const html=await response.text();assert.match(html,/<article/);assert.match(html,new RegExp('href="/guide/'+id+'" aria-current="page"'));assert.doesNotMatch(html,/\{#[a-z-]+\}|```/);
    assert.equal(await(await fetch(origin+'/guide/'+id,{method:'HEAD'})).text(),'');
    assert.equal((await fetch(origin+'/guide/'+id,{method:'POST'})).status,405);
  }
  const start=await(await fetch(origin+'/guide/start')).text();assert.ok(start.includes(origin+'/install.sh'));assert.ok(!start.includes('https://gpu.example.com'));
  const data=await(await fetch(origin+'/guide/data')).text();assert.match(data,/gpuctl data upload/);assert.match(data,/READY/);
  for(const [old,next] of [['user','start'],['datasets','data'],['projects','development'],['community','queue'],['diagnostics','results'],['ray-resources','troubleshooting'],['terminal-sessions','development'],['project-network','troubleshooting']]){
    const redirect=await fetch(origin+'/guide/'+old,{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),'/guide/'+next);
  }
  for(const path of ['/guide/admin','/guide/unknown','/ADMIN_README.md','/USER_README.md','/docs/USER_GUIDE.md','/docs/DATASETS.md','/guide/node-config.json'])assert.equal((await fetch(origin+path)).status,404,path);
  const page=await(await fetch(origin)).text();assert.equal((page.match(/href="\/guide(?:\/[^" ]*)?"/g)||[]).length,1);assert.match(page,/href="\/guide"[^>]+>使用指南/);
  for(const path of ['/guide.css','/guide.js','/cloud-files-ui.js'])assert.equal((await fetch(origin+path)).status,200);
  const cloudUI=await fetch(origin+'/cloud-files-ui.js');assert.match(cloudUI.headers.get('content-type'),/javascript/);assert.match(await cloudUI.text(),/export function cloudFilesUI/);
}
test('production guide serves formatted chapters and removes public operations manuals',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-guide-')),bootstrap=join(dir,'bootstrap');let server;
  try{await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Local-Guide-Test-Only-Password-2026!'}));const number=await port(),origin=`http://127.0.0.1:${number}`;({server}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false}));await new Promise(r=>server.listen(number,'127.0.0.1',r));await check(origin);
    const response=await fetch(origin+'/guide/start');assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);assert.doesNotMatch(response.headers.get('content-security-policy'),/unsafe-inline/);
  }finally{if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('demo and production share the same guide navigation',async()=>{const server=await createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await check(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(r=>server.close(r));}});
test('guide renderer escapes raw HTML, scripts and unsafe link schemes',()=>{
  const html=renderMarkdown('### <img src=x onerror=alert(1)>\n\n**a & b** `</code><script>` [bad](javascript:alert) [file](file:///etc/passwd) [good](/guide/data)\n\n```sh\n<script>alert(1)</script>\n```');
  assert.doesNotMatch(html,/<script|<img|href="javascript|href="file:/);assert.match(html,/&lt;script&gt;/);assert.match(html,/<strong>a &amp; b<\/strong>/);assert.match(html,/href="\/guide\/data"/);
  assert.doesNotMatch(inline('[bad](//evil.example)'),/href=/);assert.doesNotMatch(inline('[bad](https:&#47;&#47;evil.example)'),/href=/);
  assert.throws(()=>parseGuide('## Only {#start}\nmissing chapters'),/Incomplete/);assert.equal(guideTarget('/guide/admin'),null);assert.equal(guideTarget('/guide/start/../../ADMIN_README.md'),null);
});
test('production image includes only the reader guide, not operations manuals',async()=>{
  const docker=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8'),ignore=await readFile(new URL('../.dockerignore',import.meta.url),'utf8');
  assert.match(docker,/guide\.mjs/);assert.match(docker,/docs\/USER_GUIDE\.md/);assert.doesNotMatch(docker,/ADMIN_README|USER_README|docs\/DEPLOYMENT/);
  assert.match(ignore,/!docs\/USER_GUIDE\.md/);assert.doesNotMatch(ignore,/!ADMIN_README/);
});
