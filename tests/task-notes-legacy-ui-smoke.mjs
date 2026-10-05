// Real old backend and cookie authentication, no notes API shim or mock.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import {chromium} from 'playwright';

const dir=await mkdtemp(join(tmpdir(),'gpuq-old-notes-ui-')),errors=[],operations=[],external=[];
let server,browser;
try{
  // Keep exercising a real old API after the notes backend has been merged.
  // Only candidate collaboration assets, their shared motion dependency, and
  // three static routes are overlaid. Authentication/community/storage stay frozen.
  const legacy=join(dir,'legacy'),archive=join(dir,'legacy.tar'),run=promisify(execFile);
  await mkdir(legacy);
  await run('git',['archive','--format=tar','--output='+archive,'20dc58f96202626199bc8599a94f37801686f248'],{cwd:fileURLToPath(new URL('..',import.meta.url))});
  await run('tar',['-xf',archive,'-C',legacy]);await rm(archive);
  for(const name of ['community-ui.js','community.css','task-notes-ui.js','submission-keys.js','motion-ui.js','copy-help-ui.js','copy-help.css'])await copyFile(new URL('../dist/'+name,import.meta.url),join(legacy,'dist',name));
  const serverPath=join(legacy,'portal-server.mjs'),source=await readFile(serverPath,'utf8');
  const routes="files['/community-ui.js']='community-ui.js';files['/community.css']='community.css';";
  assert.equal(source.split(routes).length,2,'frozen server static route anchor must remain exact');
  await writeFile(serverPath,source.replace(routes,routes+"\nfiles['/task-notes-ui.js']='task-notes-ui.js';files['/submission-keys.js']='submission-keys.js';files['/motion-ui.js']='motion-ui.js';files['/copy-help-ui.js']='copy-help-ui.js';files['/copy-help.css']='copy-help.css';"));
  const {createPortalServer}=await import(pathToFileURL(serverPath));
  const password='Old-Backend-Browser-Fixture-2026!',bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const origin='http://127.0.0.1:'+port;
  ({server}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false}));await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const page=await browser.newPage({viewport:{width:390,height:920}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.href);return route.abort();}return route.continue();});
  page.on('request',request=>{if(request.url().endsWith('/api/call'))operations.push(request.postDataJSON()?.operation);});
  await page.goto(origin+'/#community');await page.locator('#login-form [name=username]').fill('admin');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=community]').click();
  await page.waitForFunction(()=>document.querySelector('#community-status').textContent!=='正在连接协作区…');
  assert.equal(await page.locator('#community-task-notes').isVisible(),false);assert.deepEqual(await page.locator('[data-community-tab]:visible').evaluateAll(nodes=>nodes.map(node=>node.dataset.communityTab)),['posts','chat']);
  await page.locator('[data-community-tab=posts]').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('[data-community-tab=chat]').getAttribute('aria-selected'),'true');
  await page.locator('#community-chat-body').fill('旧聊天继续可用');await page.locator('#community-chat-form [type=submit]').click();await page.locator('.chat-message').filter({hasText:'旧聊天继续可用'}).waitFor();
  // Even a scripted expansion of the hidden section cannot issue notes operations.
  await page.locator('#community-task-notes').evaluate(node=>{node.open=true;node.dispatchEvent(new Event('toggle'));});assert.equal(await page.locator('#community-notes').isVisible(),false);
  await page.locator('#notes-refresh').dispatchEvent('click');await page.locator('#task-note-form').dispatchEvent('submit');
  assert.equal(operations.some(operation=>operation?.startsWith('community.notes.')),false);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  console.log(JSON.stringify({status:'passed',checks:['real old backend','notes capability absent hides section','two-tab keyboard navigation','existing chat persists','no notes request or API shim','390px layout','no outside traffic']}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
