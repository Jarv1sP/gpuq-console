// Local in-memory browser fixture only; no listeners, external sites or jobs.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const root=new URL('../',import.meta.url),artifact=new URL('../.deployment-private/',import.meta.url);
await mkdir(artifact,{recursive:true});
const source=await readFile(new URL('dist/job-diagnostics-ui.js',root),'utf8');
const styles=await readFile(new URL('dist/styles.css',root),'utf8')+'\n'+await readFile(new URL('dist/job-diagnostics.css',root),'utf8');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  const page=await browser.newPage({viewport:{width:1280,height:960}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link id="job-diagnostic-styles"></head><body><dialog class="job-log-dialog"><div class="modal-head"><h2>训练日志 · 最近 200 行</h2><button class="button" id="close-job-log">关闭</button></div><pre></pre></dialog></body></html>');
  await page.addStyleTag({content:styles});
  await page.addScriptTag({type:'module',content:source+'\nwindow.makeDiagnostics=createJobDiagnostics;'});
  await page.waitForFunction(()=>window.makeDiagnostics);
  await page.evaluate(()=>{
    const jobId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';window.jobId=jobId;
    window.store={principal:{userId:'owner',role:'member'},call:async operation=>operation==='jobs.logs'?{text:'Ray started\n\n[GPUQ 持久诊断]\nRuntimeError: CUDA out of memory\nOOM kill=1 / PID 拒绝=2'}:{jobId,state:'PARTIAL',schedulerState:'RUNNING',workerErrorEvidence:true,attempts:[{id:'A1',state:'FAILED',gpu_indices:[0,1],gpu_uuids:['GPU-00000000-0000-0000-0000-000000000000','GPU-11111111-1111-1111-1111-111111111111'],started_at:1790700000,finished_at:1790700060}],captures:[{updatedAt:1790700060,runnerExit:{exitCode:137},resources:{peaks:{'memory.peak':1024**3,'pids.peak':80},counters:{'memory.events':{oom:1,oom_kill:1},'pids.events':{max:2}}},logs:[{source:'worker-test.err',text:'<img src=x onerror="window.pwn=true">\nRuntimeError: CUDA out of memory',truncated:false}]}]}};
    window.control=window.makeDiagnostics(window.store,()=>document.querySelector('dialog'),()=>{});window.control.install();
    document.querySelector('#close-job-log').onclick=()=>document.querySelector('dialog').close();window.control.openLogs(jobId);
  });
  await page.getByRole('button',{name:'诊断包 / 历史分配'}).click();
  await page.getByText('历史 GPU 分配',{exact:true}).waitFor();
  assert.match(await page.locator('#job-diagnostic-view').innerText(),/GPU-00000000/);
  assert.match(await page.locator('#job-diagnostic-view').innerText(),/旧任务未记录精确租约时间/);
  assert.equal(await page.locator('.diagnostic-lease-history').count(),0);
  await page.evaluate(()=>{const previous=window.store.call;window.store.call=async operation=>{const result=await previous(operation);if(operation==='jobs.diagnostics')Object.assign(result,{historyAvailable:true,historyTruncated:true,historyNextBeforeId:7,allocationHistory:[{id:8,attempt_id:'A1',gpu_index:0,gpu_uuid:'GPU-exact-lease',acquired_at:1790700000.125,released_at:1790700060.75,release_reason:'attempt finalized: EXITED_SUCCESS',source:'observed'},{id:7,attempt_id:'A0',gpu_index:1,gpu_uuid:'GPU-active-lease',acquired_at:1790699900,released_at:null,release_reason:null,source:'migrated_active'}]});return result;};});
  await page.getByRole('button',{name:'诊断包 / 历史分配'}).click();await page.locator('.diagnostic-lease-history').waitFor();
  for(const text of ['GPU-exact-lease','.125','.750','尚无释放记录','升级时补记','继续查询游标：7','运行过程历史'])assert.ok((await page.locator('#job-diagnostic-view').innerText()).includes(text),text);
  await page.getByText('worker-test.err',{exact:true}).click();
  assert.equal(await page.evaluate(()=>window.pwn),undefined);assert.equal(await page.locator('#job-diagnostic-view img').count(),0);
  await page.screenshot({path:new URL('diagnostics-desktop.png',artifact).pathname});
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载诊断 JSON'}).click();
  assert.equal((await download).suggestedFilename(),'gpuq-diagnostics-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:new URL('diagnostics-mobile.png',artifact).pathname});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>{window.store.principal=null;window.control.sync();});
  assert.equal(await page.locator('dialog').evaluate(node=>node.open),false);
  assert.equal(await page.locator('#job-diagnostic-view').innerText(),'');
  console.log('Diagnostic browser smoke: desktop/mobile, exact GPU leases with schema9 fallback, attempt history, escaped worker logs, JSON download, account-reset cleanup passed');
}finally{await browser.close();}

// Terminal history remains immutable during explicit observation and lease recovery.
await import("./job-recovery-ui-smoke.mjs");
