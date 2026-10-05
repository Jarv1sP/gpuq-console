// Real-browser acceptance against a disposable, loopback-only portal and fake
// dataset bridge. No SSH, Tailscale, production accounts or GPU jobs are used.
// CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
//   node tests/datasets-ui-smoke.mjs
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';

const dir = await mkdtemp(join(tmpdir(), 'gpuq-datasets-browser-'));
const screenshots = process.env.UI_SCREENSHOTS || '/tmp/gpuq-datasets-ui';
const password = 'Local-Dataset-UI-Only-Password-2026!';
const version = 'a'.repeat(64), ref = {dataset: 'sample', version};
const calls = [], errors = [], blocked = [], httpErrors = [], authenticated = new WeakSet(), phases = new Map([['gpu-1', 'REGISTERED']]);
let moreLocalVersions=false, holdLookup=false, releaseLookup=null;
let server, browser, service, waitingList = null, listGate = null;
const reserve = net.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;

try {
  await mkdir(screenshots, {recursive: true});
  const bootstrap = join(dir, 'bootstrap.json'), statusPath = join(dir, 'status.json');
  await writeFile(bootstrap, JSON.stringify({username: 'admin', password}), {mode: 0o600});
  await writeFile(statusPath, JSON.stringify({version: 1, checkedAt: new Date().toISOString(),
    hosts: MACHINES.map(machine => ({id: machine.id, reachable: true,
      gpus: Array.from({length: machine.cards}, (_, index) => ({index, memoryTotalMiB: 32768,
        memoryUsedMiB: 0, utilization: 0, temperatureC: 30, powerDrawW: 15,
        powerLimitW: 450, processesAvailable: true, processes: []})),
      gpuq: {connected: true, observeOnly: false, schedulableIndices: [0, 1], jobs: []}}))}));
  const bridge = async (machine, operation, args) => {
    calls.push({machine, operation, args: structuredClone(args)});
    assert.ok(MACHINES.some(item => item.id === machine));
    if (operation === 'projects.list') return {projects: []};
    if (operation === 'datasets.capacity') return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3,totalInodes:100000,availableInodes:50000,inodeUsageKnown:true,guarded:true};
    if (operation === 'datasets.list') {
      if (machine === 'gpu-2' && listGate) {waitingList?.(); await listGate;}
      const state = phases.get(machine) || 'READY';
      const entries = [{dataset: machine === 'gpu-1' ? 'sample' : 'another', ownerIds:[args.userId], versions: [{version, state,canPrepare:true,
        files: 12, bytes: 128 * 1024 ** 2, ...(state === 'FAILED' ? {error: 'Test preparation interrupted; safe to retry.'} : {})}]}];
      if(moreLocalVersions&&machine==='gpu-1')entries[0].versions.push({version:'d'.repeat(64),state:'READY',canPrepare:true,files:4,bytes:2*1024**2});
      if (args.hostAdmin) entries.push({dataset: 'admin-private', versions: [{version: 'b'.repeat(64), state: 'READY', files: 1, bytes: 12}]});
      return {datasets: entries};
    }
    if (operation === 'datasets.prepare') {
      assert.deepEqual({dataset: args.dataset, version: args.version}, ref);
      phases.set(machine, 'PREPARING');
      return {...ref, state: 'PREPARING', operationId: 'c'.repeat(64)};
    }
    if (operation === 'datasets.status') return {...ref, state: phases.get(machine) || 'READY'};
    if (operation === 'sync') return {state: 'PENDING', nodeJobId: 'fake-' + args.job.id, assignedIndices: []};
    throw Error(`Unexpected fake bridge operation: ${operation}`);
  };
  ({server, service} = await createPortalServer({database: join(dir, 'portal.sqlite'), bootstrap, origin,
    secure: false, statusPath, bridge}));
  clearInterval(service.executionTimer);
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const adminLogin = await service.login('admin', password);
  const user = (await service.invoke(adminLogin.token, 'users.create', {username: 'dataset-browser-user', password})).result;
  await service.invoke(adminLogin.token, 'policy.save', {userId: user.id,
    policyVersion: service.store.get(user.id).policyVersion, total: 2, limits: {'gpu-1': 1, 'gpu-2': 1}});

  browser = await chromium.launch({headless: true,
    ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
  const admin = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const member = await browser.newPage({viewport: {width: 1440, height: 1000}});
  for (const page of [admin, member]) {
    page.on('pageerror', error => {errors.push(error.message);console.error('Dataset browser error:',error.message);});
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    page.on('response', response => {
      if (response.status() >= 400) httpErrors.push({status: response.status(),
        path: new URL(response.url()).pathname, operation: response.request().postDataJSON()?.operation,
        authenticated: authenticated.has(page)});
    });
    await page.context().route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      blocked.push(route.request().url()); return route.abort('blockedbyclient');
    });
  }
  async function login(page, username) {
    await page.goto(origin);
    await page.locator('#login-form [name=username]').fill(username);
    await page.locator('#login-form [name=password]').fill(password);
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#login-dialog').waitFor({state: 'hidden'});
    authenticated.add(page);
    await page.locator('[data-nav=datasets]').click();
  }
  async function refresh(page) {
    await Promise.all([page.waitForResponse(response => response.url() === origin + '/api/call' &&
      response.request().postDataJSON()?.operation === 'datasets.catalog'), page.locator('#datasets-refresh').click()]);
    await page.locator('#datasets-refresh').waitFor({state: 'visible'});
    await page.waitForFunction(() => !document.querySelector('#datasets-refresh').disabled);
  }
  async function capture(page, name) {
    await page.waitForFunction(() => {
      const toast = document.querySelector('#toast');
      return !toast || (!toast.classList.contains('visible') && Number(getComputedStyle(toast).opacity) === 0);
    });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({path: join(screenshots, name), fullPage: await page.locator('dialog[open]').count()===0, animations: 'disabled'});
  }
  async function prepare(page) {
    await Promise.all([page.waitForResponse(response => response.url() === origin + '/api/call' &&
      response.request().postDataJSON()?.operation === 'datasets.catalog'),
      page.locator('[data-prepare-dataset="sample"]').click()]);
    await page.waitForFunction(() => document.querySelector('#dataset-catalog')?.textContent.includes('准备中'));
  }
  const card = page => page.locator('.dataset-card').filter({has: page.locator('h3', {hasText: /^sample$/})});

  await login(admin, 'admin'); await refresh(admin);
  assert.equal(await admin.locator('.dataset-card').count(), 2);
  assert.doesNotMatch(await admin.locator('#dataset-catalog').textContent(), /admin-private/);
  assert.equal(await card(admin).locator('.dataset-owner').textContent(), '所属用户：admin');
  assert.equal(calls.at(-1).args.userId, 'builtin-admin'); assert.equal(calls.at(-1).args.hostAdmin, false);
  assert.match(await admin.locator('#datasets-capacity').textContent(),/512\.00 GiB.*不是个人配额/);
  assert.equal(await admin.locator('.dataset-card h3',{hasText:/^another$/}).count(),1,'Same dataset and version is merged across machines');
  assert.equal(await admin.locator('#datasets-add').evaluate(node=>node.open),false,'Import controls start collapsed');
  await capture(admin, 'datasets-admin-desktop.png');
  phases.set('gpu-2', 'STAGING');
  await admin.locator('[name=dataset-machine]').selectOption('gpu-2');
  await admin.locator('[data-prepare-dataset="another"]').waitFor();
  assert.equal(await admin.locator('[data-prepare-dataset="another"]').isEnabled(), true, 'Interrupted staging must remain resumable');
  assert.equal(await admin.locator('[data-use-dataset="another"]').isEnabled(), true,'Approved interrupted staging can enter preparation-before-training');
  phases.set('gpu-2', 'READY');

  await login(member, 'dataset-browser-user'); await refresh(member);
  assert.deepEqual(await member.locator('[name=dataset-machine] option').evaluateAll(options => options.map(option => option.value)), ['gpu-1', 'gpu-2']);
  assert.equal(await member.locator('.dataset-card').count(), 2);
  assert.doesNotMatch(await member.locator('#dataset-catalog').textContent(), /admin-private/);
  assert.equal(calls.at(-1).args.userId, user.id); assert.equal(calls.at(-1).args.hostAdmin, false);
  assert.match(await card(member).textContent(), /待准备/);
  assert.equal(await card(member).locator('.dataset-owner').textContent(), '所属用户：dataset-browser-user');
  assert.equal(await card(member).locator('[data-prepare-dataset]').isEnabled(), true);
  assert.equal(await card(member).locator('[data-use-dataset]').isEnabled(), true);
  assert.equal(await card(member).locator('[data-use-dataset]').textContent(), '准备后训练');
  assert.equal(await card(member).locator('input[readonly]').inputValue(), 'sample@' + version);
  assert.equal(await member.locator('a[href="/guide"]').count(),1,'The workbench has exactly one reader guide entry');
  assert.equal(await member.locator('[data-user-guide]').count(),0,'The shared entry is not duplicated by a workspace guide button');
  const [guide] = await Promise.all([member.waitForEvent('popup'), member.locator('a[href="/guide"]:visible').click()]);
  await guide.waitForLoadState('domcontentloaded');
  await guide.locator('.guide-card[href="/guide/data"]').click();
  assert.equal(new URL(guide.url()).pathname, '/guide/data');
  assert.equal(await guide.getByRole('heading', {level: 1}).textContent(), '数据集');
  assert.equal(await guide.locator('nav[aria-label="指南章节"] a[aria-current="page"]').getAttribute('href'), '/guide/data');
  assert.ok((await guide.locator('.guide-prose pre code').allTextContents()).some(block => block.includes('gpuctl data upload ')), 'Dataset guide includes actionable upload instructions');
  await guide.close();
  await capture(member, 'datasets-member-registered.png');
  await member.locator('#datasets-add > summary').click();
  await member.locator('[name=dataset-name]').fill('preserved-draft');
  await member.locator('[data-dataset-source=link]').click();
  await member.locator('[name=cloud-source]').selectOption('https');
  await member.locator('[name=cloud-url]').fill('https://example.invalid/dataset.zip');
  await member.locator('#dataset-organize-next').click();
  assert.equal(await member.locator('#dataset-panel-workspace').isVisible(),true);
  assert.match(await member.locator('#dataset-panel-workspace').textContent(),/不会自动解压/);
  assert.equal(await member.locator('#dataset-add-dialog #cloud-files-form').count(),1,'The import sheet preserves the private cloud file panel');
  assert.equal(await member.locator('#dataset-add-dialog [name=cloud-files-path]').count(),1);
  await member.locator('[data-dataset-source=directory]').click();
  assert.equal(await member.locator('[name=dataset-name]').inputValue(),'preserved-draft');
  await member.locator('[data-dataset-source=link]').click();
  assert.equal(await member.locator('[name=cloud-url]').inputValue(),'https://example.invalid/dataset.zip');
  await member.locator('#dataset-source-link').press('ArrowRight');
  assert.equal(await member.locator('#dataset-source-workspace').getAttribute('aria-selected'),'true');
  assert.equal(calls.some(call=>/cloud|workspace/.test(call.operation)),false,'Selecting an import path never imports, extracts, publishes or starts a terminal');
  await member.locator('[data-dataset-add-close]').click();
  assert.equal(await member.locator('#dataset-add-dialog').isVisible(),false,'The import sheet closes without discarding method drafts');
  await member.locator('#datasets-add > summary').click();
  await member.locator('#dataset-add-dialog').waitFor({state:'visible'});
  await member.evaluate(()=>{location.hash='work';});
  await member.locator('#page-work').waitFor({state:'visible'});
  await member.locator('#dataset-add-dialog').waitFor({state:'hidden'});
  assert.equal(await member.locator('#dataset-add-dialog').getAttribute('open'),null,'A room deep link closes the native sheet and releases background input');
  await member.locator('[data-nav=datasets]').click();
  await member.locator('#datasets-add > summary').click();
  await member.locator('#dataset-add-dialog').waitFor({state:'visible'});
  assert.equal(await member.locator('[name=dataset-name]').inputValue(),'preserved-draft','Changing rooms keeps the upload draft');
  await member.locator('[data-dataset-add-close]').click();

  // Delay one machine's response: old machine entries must disappear immediately.
  let releaseList; listGate = new Promise(resolve => {releaseList = resolve;});
  const listStarted = new Promise(resolve => {waitingList = resolve;});
  await member.locator('[name=dataset-machine]').selectOption('gpu-2'); await listStarted;
  assert.equal(await member.locator('.dataset-card').count(), 0);
  assert.equal(await member.locator('[name=dataset-machine]').isDisabled(), true);
  releaseList(); listGate = null; waitingList = null;
  await member.locator('.dataset-card h3', {hasText: 'another'}).waitFor();
  assert.match(await card(member).textContent(), /本机没有此版本/);
  assert.equal(await card(member).locator('[data-use-dataset]').isDisabled(),true,'Remote READY is not current-machine READY');
  await member.locator('[name=dataset-machine]').selectOption('gpu-1');
  await card(member).waitFor();

  await prepare(member);
  assert.match(await card(member).textContent(), /准备中/);
  assert.equal(service.store.jobs.length, 0, 'Preparing data must not reserve any GPU');
  phases.set('gpu-1', 'FAILED'); await refresh(member);
  assert.match(await card(member).textContent(), /准备失败/);
  assert.match(await card(member).textContent(), /Test preparation interrupted/);
  assert.equal(await card(member).locator('[data-prepare-dataset]').isEnabled(), true);
  assert.equal(await card(member).locator('[data-use-dataset]').isDisabled(), true,'Failed data requires an explicit preparation retry, not another doomed training');
  await capture(member, 'datasets-member-failed-retry.png');
  await prepare(member);
  assert.equal(calls.filter(call => call.operation === 'datasets.prepare').length, 2);
  phases.set('gpu-1', 'READY'); await refresh(member);
  assert.equal(await card(member).locator('[data-prepare-dataset]').isDisabled(), true);
  assert.equal(await card(member).locator('[data-use-dataset]').isEnabled(), true);

  await member.setViewportSize({width: 390, height: 844});
  await capture(member, 'datasets-member-mobile-ready.png');
  await member.screenshot({path:join(screenshots,'datasets-unified-mobile-viewport.png'),fullPage:false});
  const layout = await member.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
  assert.ok(layout.scroll <= layout.width + 1, `390px dataset page overflows: ${JSON.stringify(layout)}`);
  await card(member).locator('[data-use-dataset]').click();
  await member.locator('#work-submit').waitFor({state: 'visible'});
  assert.equal(await member.locator('#page-datasets').isVisible(),true,'Selecting a fixed dataset opens submission above the current room');
  assert.equal(await member.locator('#page-work').isVisible(),false,'Dataset selection preserves its page context');
  assert.equal(await member.locator('#train-form [name=machine]').inputValue(), 'gpu-1');
  assert.equal(await member.locator('#train-form [name=datasets]').inputValue(), 'sample@' + version);
  assert.equal(await member.locator('#train-form').evaluate(form => form.closest('details').open), true);
  await member.locator('#train-form [name=command]').fill('python train.py --dataset /data2/sample');
  await member.locator('#train-form [name=task-description]').fill('核对固定数据版本后的训练');
  await capture(member, 'datasets-mobile-training-form.png');
  const trainLayout = await member.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
  assert.ok(trainLayout.scroll <= trainLayout.width + 1, `390px training page overflows: ${JSON.stringify(trainLayout)}`);
  const submitted = member.waitForResponse(response => response.url() === origin + '/api/call' && response.request().postDataJSON()?.operation === 'jobs.submit');
  await member.locator('#train-form [type=submit]').click();
  const response = await submitted;
  assert.equal(response.status(), 200, await response.text());
  assert.equal(response.request().postDataJSON().args.prepareData, true, 'Task metadata must not remove preparation-before-training');
  assert.equal(response.request().postDataJSON().args.description, '核对固定数据版本后的训练');
  assert.equal(service.store.jobs.length, 1);
  assert.equal(service.store.jobs[0].description, '核对固定数据版本后的训练');
  assert.equal(service.store.jobs[0].machine, 'gpu-1');
  assert.deepEqual(service.store.jobs[0].spec.datasets, [ref]);
  assert.deepEqual(service.store.jobs[0].spec.argv, ['/bin/bash', '-c', 'python train.py --dataset /data2/sample']);
  while (service.reconciling) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls.find(call => call.operation === 'sync').args.job.datasets, [ref]);
  // Public login no longer probes authenticated state. Require zero HTTP
  // and console errors, without the former pre-login 401 exception.
  assert.deepEqual(httpErrors, [], 'Unexpected HTTP errors');
  assert.deepEqual(errors, [], 'Unexpected browser errors');
  assert.deepEqual(blocked, [], 'Unexpected external requests');
  // Two explicit dataset choices: the newer choice must survive an older lookup.
  await member.locator('#close-submit').click();await member.locator('#work-submit').waitFor({state:'hidden'});
  moreLocalVersions=true;await refresh(member);
  await Promise.all([member.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='projects.list'&&response.request().postDataJSON()?.args.machine==='gpu-2'),member.locator('#context-machine').selectOption('gpu-2')]);
  let notifyHeld,rejectHeld;const held=new Promise((resolve,reject)=>{notifyHeld=resolve;rejectHeld=reject;});
  await member.route('**/api/call',async route=>{
    const request=route.request().postDataJSON();
    if(holdLookup&&request.operation==='projects.list'&&request.args.machine==='gpu-1'){
      holdLookup=false;let response;
      try{response=await route.fetch({timeout:10000});}catch(error){rejectHeld(error);await route.abort();return;}
      await new Promise(resolve=>{releaseLookup=resolve;notifyHeld();});
      await route.fulfill({response});
    }else await route.continue();
  });
  holdLookup=true;
  const chosen=value=>member.locator('article.dataset-card').filter({has:member.locator('input[value="'+value+'"]')}).locator('[data-use-dataset]');
  await chosen('sample@'+version).click();
  let heldTimeout;
  try{await Promise.race([held,new Promise((_,reject)=>{heldTimeout=setTimeout(()=>reject(new Error('The first dataset choice must request its server projects')),10000);})]);}
  finally{clearTimeout(heldTimeout);}
  if(await member.locator('#work-submit').isVisible()){await member.locator('#close-submit').click();await member.locator('#work-submit').waitFor({state:'hidden'});}
  const latest='sample@'+'d'.repeat(64);
  await chosen(latest).click();await member.locator('#work-submit').waitFor({state:'visible'});
  const before=await member.locator('#train-form [name=datasets]').inputValue();
  const delivered=member.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='projects.list'&&response.request().postDataJSON()?.args.machine==='gpu-1');
  releaseLookup();await delivered;await member.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  const after=await member.locator('#train-form [name=datasets]').inputValue();
  assert.equal(before,latest,'The new choice is visible before the old reply arrives');
  assert.equal(after,latest,'An older server lookup must not replace the newer fixed dataset choice');

  // The same intent fence must also hold when the second choice changes node.
  await member.locator('#close-submit').click();await member.locator('#work-submit').waitFor({state:'hidden'});
  await Promise.all([member.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='projects.list'&&response.request().postDataJSON()?.args.machine==='gpu-2'),member.locator('#context-machine').selectOption('gpu-2')]);
  const crossNodeHeld=new Promise(resolve=>{notifyHeld=resolve;});holdLookup=true;
  await chosen('sample@'+version).click();
  try{await Promise.race([crossNodeHeld,new Promise((_,reject)=>{heldTimeout=setTimeout(()=>reject(new Error('The cross-node first choice must request projects')),10000);})]);}
  finally{clearTimeout(heldTimeout);}
  await Promise.all([member.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='datasets.catalog'),member.locator('[name=dataset-machine]').selectOption('gpu-2')]);
  await member.locator('[data-use-dataset=another]').waitFor({state:'visible'});
  await chosen('another@'+version).click();await member.locator('#work-submit').waitFor({state:'visible'});
  const oldReply=member.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='projects.list'&&response.request().postDataJSON()?.args.machine==='gpu-1');
  releaseLookup();await oldReply;await member.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  assert.equal(await member.locator('#train-form [name=machine]').inputValue(),'gpu-2','An old node lookup cannot restore its server');
  assert.equal(await member.locator('#train-form [name=datasets]').inputValue(),'another@'+version,'The newest node and fixed version remain paired');

  // Native/programmatic close must cancel pending selection, not only its button.
  await Promise.all([member.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='datasets.catalog'),member.locator('[name=dataset-machine]').selectOption('gpu-1')]);
  const closedHeld=new Promise(resolve=>{notifyHeld=resolve;});holdLookup=true;
  // The existing submit sheet is modal, so use the same delegated UI event as
  // the real dataset button without changing the sheet's native close behavior.
  await member.evaluate(ref=>document.dispatchEvent(new CustomEvent('gpuq-open-submit',{detail:{machine:'gpu-1',datasetRef:ref}})),'sample@'+version);
  try{await Promise.race([closedHeld,new Promise((_,reject)=>{heldTimeout=setTimeout(()=>reject(new Error('The close-race choice must request projects')),10000);})]);}
  finally{clearTimeout(heldTimeout);}
  await member.evaluate(()=>document.querySelector('#work-submit').close());await member.locator('#work-submit').waitFor({state:'hidden'});
  const closedReply=member.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='projects.list'&&response.request().postDataJSON()?.args.machine==='gpu-1');
  releaseLookup();await closedReply;await member.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  assert.equal(await member.locator('#work-submit').isVisible(),false,'A late lookup must not reopen a generically closed submit sheet');
  console.log('DATASETS UI PASS: owner-filtered merged catalogs; capacity is not personal quota; collapsed three-source import with draft preservation, keyboard tabs and no implicit actions; authorized machine choices; remote READY never unlocks current-machine training; no stale catalog on machine switch; registered → prepare → failed → retry → ready; exact immutable ref and jobspec; 390px layout; zero HTTP or browser errors and no external requests.');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  holdLookup=false;releaseLookup?.();
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(dir, {recursive: true, force: true});
}
