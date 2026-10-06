// The parent imports only builtins; its deadline does not depend on worker timers.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const worker=process.argv.includes('--task-display-ui-worker');
if(!worker){
  const child=spawn(process.execPath,['--max-old-space-size=512',fileURLToPath(import.meta.url),'--task-display-ui-worker'],{stdio:['ignore','inherit','inherit','ipc'],detached:process.platform!=='win32'});
  let timedOut=false,force;
  const stop=signal=>{try{if(process.platform!=='win32')process.kill(-child.pid,signal);else child.kill(signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
  const deadline=setTimeout(()=>{timedOut=true;stop('SIGTERM');force=setTimeout(()=>stop('SIGKILL'),3000);},120000);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
  clearTimeout(deadline);clearTimeout(force);process.exitCode=timedOut?124:code??1;
}else{
  const [{default:assert},{createServer},{readFile,mkdir},{chromium},{taskLabelEditorHTML},{inspectGeometry}]=await Promise.all([
    import('node:assert/strict'),import('node:http'),import('node:fs/promises'),import('playwright'),import('../dist/task-display-ui.js'),import('./layout-geometry.mjs')]);
  let browser,server;
  const cleanup=async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));};
  process.once('disconnect',()=>{cleanup().finally(()=>process.exit(124));});
  process.once('SIGTERM',()=>{cleanup().finally(()=>process.exit(124));});
  try{
    const job={machine:'gpu-1',nodeJobId:'J123456789abc',userId:'demo-user-1'};
    assert.equal(taskLabelEditorHTML(job,{userId:'demo-user-2',role:'member'}),'');
    assert.equal(taskLabelEditorHTML({...job,nodeJobId:'UNKNOWN'},{role:'admin'}),'');
    assert.ok(taskLabelEditorHTML(job,{role:'admin'}).includes('data-task-label-editor'));
    const html='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><main style="max-width:700px;margin:24px;padding:12px">'+taskLabelEditorHTML(job,{userId:'demo-user-1',role:'member'})+'</main><script type="module">import {installTaskLabelEditor} from "/task-display-ui.js";globalThis.calls=[];globalThis.mode="ok";let revision="a".repeat(64);globalThis.store={principal:{userId:"demo-user-1",role:"member"},call:async(op,args)=>{calls.push({op,args});if(mode==="old")return {available:false};if(mode==="lost"&&op==="tasks.display.set")throw Error("写入结果未确认");if(mode==="revoked"){store.principal={userId:"demo-user-2",role:"member"};return {protocol:"task-display-edit-v1",nodeJobId:args.nodeJobId,available:true,name:"不得显示",description:"",revision};}if(op==="tasks.display.set")revision="b".repeat(64);return {protocol:"task-display-edit-v1",nodeJobId:args.nodeJobId,available:true,name:op==="tasks.display.set"?args.name:"原名称",description:op==="tasks.display.set"?args.description:"原描述",revision};}};installTaskLabelEditor(store,{refresh:async()=>{globalThis.refreshed=true;}});globalThis.ready=true;</script>';
    server=createServer(async(req,res)=>{
      if(req.url==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
      const files={'/styles.css':'../dist/styles.css','/task-display-ui.js':'../dist/task-display-ui.js'};
      if(!files[req.url]){res.writeHead(404);res.end();return;}
      res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(new URL(files[req.url],import.meta.url)));
    });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    const page=await browser.newPage(),errors=[],external=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:900});await page.goto(origin);await page.waitForFunction(()=>globalThis.ready);
      await page.locator('summary').focus();await page.keyboard.press('Enter');await page.locator('[data-task-label-read]').click();await page.locator('[data-task-label-form]').waitFor({state:'visible'});
      await page.locator('[name=task-label-name]').fill('中文｜续训');await page.locator('[name=task-label-description]').fill('更新的说明');
      await page.locator('[data-task-label-form] [type=submit]').click();await page.waitForFunction(()=>globalThis.refreshed===true);
      const calls=await page.evaluate(()=>globalThis.calls);assert.equal(calls.length,2);assert.deepEqual(calls[1],{op:'tasks.display.set',args:{machine:job.machine,nodeJobId:job.nodeJobId,name:'中文｜续训',description:'更新的说明',revision:'a'.repeat(64)}});
      const geometry=await inspectGeometry(page,{roots:['main'],controls:'button,input,textarea,summary'});assert.deepEqual(geometry.failures,[],JSON.stringify(geometry));
      if(process.env.UI_SCREENSHOTS){await mkdir(process.env.UI_SCREENSHOTS,{recursive:true});await page.mouse.move(0,0);await page.locator('body').click({position:{x:2,y:2}});await page.screenshot({path:process.env.UI_SCREENSHOTS+'/task-label-'+width+'.png',fullPage:true});}
    }
    await page.reload();await page.waitForFunction(()=>globalThis.ready);await page.locator('summary').click();await page.evaluate(()=>globalThis.mode='old');await page.locator('[data-task-label-read]').click();await page.waitForFunction(()=>document.querySelector('[data-task-label-status]').textContent.includes('暂不能修改'));
    assert.equal(await page.locator('form').isVisible(),false);assert.equal(await page.evaluate(()=>calls.length),1);
    await page.evaluate(()=>globalThis.mode='ok');await page.locator('[data-task-label-read]').click();await page.locator('form').waitFor({state:'visible'});await page.evaluate(()=>globalThis.mode='lost');
    await page.locator('[type=submit]').click();await page.waitForFunction(()=>document.querySelector('[data-task-label-status]').textContent.includes('不会自动重发'));
    assert.equal(await page.locator('[type=submit]').isDisabled(),true);assert.equal(await page.evaluate(()=>calls.filter(c=>c.op==='tasks.display.set').length),1);
    await page.locator('[data-task-label-read]').click();await page.locator('[type=submit]').waitFor({state:'visible'});await page.evaluate(()=>globalThis.mode='revoked');await page.locator('[data-task-label-read]').click();
    assert.equal(await page.locator('[name=task-label-name]').inputValue(),'原名称');assert.equal(await page.evaluate(()=>calls.filter(c=>c.op==='tasks.display.set').length),1);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('TASK DISPLAY UI PASS: fixed IDs, role filtering, CAS, lost reply, old nodes, keyboard, 1440/390/320');
  }finally{await cleanup();process.removeAllListeners('disconnect');if(process.connected)process.disconnect();}
}
