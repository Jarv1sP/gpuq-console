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
import {guardedRoute} from './browser-route-guard.mjs';
import {trainingPlan,trainingSource} from './training-storage-fixture.mjs';

const dir = await mkdtemp(join(tmpdir(), 'gpuq-datasets-browser-'));
const screenshots = process.env.UI_SCREENSHOTS || '/tmp/gpuq-datasets-ui';
const password = 'Local-Dataset-UI-Only-Password-2026!';
const version = 'a'.repeat(64), ref = {dataset: 'sample', version};
const calls = [], requests = [], errors = [], blocked = [], httpErrors = [], authenticated = new WeakSet(), phases = new Map([['gpu-1', 'REGISTERED']]);
const unsupportedTrainingResponses = [], trainingResponseChecks = [], trainingConsoleErrors = [];
let legacyTrainingCapabilities = false;
const fixtureOwners=['builtin-admin'];
let moreLocalVersions=false, holdLookup=false, releaseLookup=null,heldDelivery=null,heldRequest=null;
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
    if (operation === 'storage.training.plan') {
      assert.equal(args.hostAdmin,false);
      return trainingPlan(machine,args);
    }
    if (operation === 'datasets.training.status') {
      assert.equal(args.hostAdmin,false);
      return trainingSource(machine,args,{state:phases.get(machine)||'READY',bytes:128*1024**2,files:12,directories:0});
    }
    if(operation==='datasets.upload.routes'){assert.equal(args.hostAdmin,false);assert.equal(args.uploadId,undefined);return {available:false,protocol:'dataset-upload-v1',reason:'not-configured',relayLimitBytes:256*1024**2};}
    if (operation === 'datasets.capacity') return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3,totalInodes:100000,availableInodes:50000,inodeUsageKnown:true,guarded:true};
    if (operation === 'datasets.list') {
      if (machine === 'gpu-2' && listGate) {waitingList?.(); await listGate;}
      const state = phases.get(machine) || 'READY';
      const entries = [{dataset: machine === 'gpu-1' ? 'sample' : 'another', ownerIds:fixtureOwners, versions: [{version, state,canPrepare:true,
        files: 12, bytes: 128 * 1024 ** 2, ...(state === 'FAILED' ? {error: 'Test preparation interrupted; safe to retry.'} : {})}]}];
      if(moreLocalVersions&&machine==='gpu-1')entries[0].versions.push({version:'d'.repeat(64),state:'READY',canPrepare:true,files:4,bytes:2*1024**2});
      if (args.hostAdmin) entries.push({dataset: 'admin-private', ownerIds:['another-owner'], versions: [{version: 'b'.repeat(64), state: 'READY', files: 1, bytes: 12}]});
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
  try {await service.invoke(adminLogin.token, 'datasets.training.capabilities', {machine: MACHINES[0].id, ...ref});}
  catch (error) {legacyTrainingCapabilities = error.status === 400 && error.message === '未知执行操作。';}
  const user = (await service.invoke(adminLogin.token, 'users.create', {username: 'dataset-browser-user', password})).result;
  fixtureOwners.push(user.id);
  await service.invoke(adminLogin.token, 'policy.save', {userId: user.id,
    policyVersion: service.store.get(user.id).policyVersion, total: 2, limits: {'gpu-1': 1, 'gpu-2': 1}});

  browser = await chromium.launch({headless: true,
    ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
  const admin = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const member = await browser.newPage({viewport: {width: 1440, height: 1000}});
  for (const page of [admin, member]) {
    page.on('request',request=>{if(request.url()===origin+'/api/call')requests.push({page,...request.postDataJSON()});});
    page.on('pageerror', error => {errors.push(error.message);console.error('Dataset browser error:',error.message);});
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (legacyTrainingCapabilities && message.location().url === origin + '/api/call' &&
          message.text() === 'Failed to load resource: the server responded with a status of 400 (Bad Request)') trainingConsoleErrors.push({page, text: message.text()});
      else errors.push(message.text());
    });
    page.on('response', response => {
      if (response.status() < 400) return;
      const failure = {status: response.status(),
        path: new URL(response.url()).pathname, operation: response.request().postDataJSON()?.operation,
        authenticated: authenticated.has(page)};
      // Only the actual legacy Portal's exact unknown-operation reply is
      // expected; ordinary 400s, every other op and supported backends stay strict.
      if (legacyTrainingCapabilities && failure.status === 400 && failure.path === '/api/call' &&
          failure.operation === 'datasets.training.capabilities' && failure.authenticated) {
        trainingResponseChecks.push(response.json().then(body => {
          if (body.error === '未知执行操作。') unsupportedTrainingResponses.push({page, ...failure});
          else httpErrors.push(failure);
        }, () => httpErrors.push(failure)));
      } else httpErrors.push(failure);
    });
    await page.context().route('**/*', guardedRoute(async route => {
      if (route.request().url() === origin + '/api/call' && route.request().method() === 'POST') {
        const {operation, args} = route.request().postDataJSON();
        if (operation === 'datasets.overview') {
          assert.ok(authenticated.has(page), 'Overview is read only after login');
          assert.deepEqual(args, {}, 'Overview accepts no simulated privilege or target');
          return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({result: {protocol: 0}})});
        }
      }
      if (new URL(route.request().url()).origin === origin){await route.continue();return;}
      blocked.push(route.request().url());await route.abort('blockedbyclient');
    }));
  }
  async function login(page, username) {
    await page.goto(origin);
    await page.locator('#login-form [name=username]').fill(username);
    await page.locator('#login-form [name=password]').fill(password);
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#login-dialog').waitFor({state: 'hidden'});
    authenticated.add(page);
    await page.locator('[data-nav=work]').click();
    for(const machine of ['gpu-2','gpu-1']){
      await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
      await page.locator('[name=workspace-machine]').selectOption(machine);
      await page.waitForFunction(machine=>document.querySelector('[name=dataset-machine]')?.value===machine&&!document.querySelector('[name=workspace-machine]').disabled,machine,{timeout:10000});
      assert.equal(await page.evaluate(()=>document.body.dataset.room),'work');
      assert.equal(await page.locator('#page-datasets').evaluate(section=>section.hidden),true);
      assert.deepEqual(requests.filter(request=>request.page===page&&request.operation.startsWith('datasets.')),[],'Changing workbench context does not read a hidden dataset directory or capacity');
    }
    await Promise.all([page.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='datasets.catalog'&&response.request().postDataJSON()?.args.machine==='gpu-1'),page.locator('[data-nav=datasets]').click()]);
    await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
    assert.ok(requests.some(request=>request.page===page&&request.operation==='datasets.catalog'&&request.args.machine==='gpu-1'),'Entering the dataset room performs its deferred read for the current server');
  }
  async function refresh(page) {
    if(!await page.locator('#datasets-refresh').isVisible()&&await page.locator('[data-v3-back]').isVisible())await page.locator('[data-v3-back]').click();
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
  const row=(page,id)=>page.locator('[data-v3-select="'+id+'"]');
  const detail=page=>page.locator('#warehouse-inspector');
  const cache=(page,id='sample',machine='gpu-1')=>page.locator('[data-v3-cache="'+machine+'"][data-dataset="'+id+'"]');
  async function selectDataset(page,id,versionChoice=null){
    if(!await row(page,id).isVisible()&&await page.locator('[data-v3-back]').isVisible())await page.locator('[data-v3-back]').click();
    await row(page,id).click();
    if(versionChoice&&await page.locator('[data-v3-version]').count())await page.locator('[data-v3-version]').selectOption(versionChoice);
    await detail(page).locator('[data-use-dataset="'+id+'"]').waitFor({state:'visible'});
  }
  async function switchMachine(page,machine){
    await page.locator('#context-machine').selectOption(machine);
    await page.waitForFunction(machine=>document.querySelector('[name=dataset-machine]').value===machine&&!document.querySelector('#datasets-refresh').disabled,machine);
  }
  async function setDatasetMachine(page,machine){
    await page.locator('[data-v3-upload]').first().click();await page.locator('[name=dataset-machine]').selectOption(machine);await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);await page.locator('[data-dataset-add-close]').click();
  }
  async function prepare(page){
    await selectDataset(page,'sample');
    await Promise.all([page.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='datasets.prepare'),cache(page).click()]);
    await page.waitForFunction(()=>document.querySelector('#warehouse-inspector')?.textContent.includes('取回中'));
  }

  await login(admin,'admin');await refresh(admin);
  assert.equal(await admin.locator('[data-v3-select]').count(),3);
  assert.match(await admin.locator('#dataset-catalog').textContent(),/admin-private/);
  await selectDataset(admin,'admin-private');
  assert.equal(await detail(admin).locator('[data-use-dataset]').isDisabled(),true,'Admin metadata visibility grants no personal dataset ownership');
  await selectDataset(admin,'sample');
  assert.equal(await row(admin,'sample').locator('.v3-owner').textContent(),'admin、dataset-browser-user');
  assert.equal(await row(admin,'sample').locator('.v3-owner').getAttribute('title'),'所属 admin、dataset-browser-user');
  assert.equal(await detail(admin).locator('.v3-meta>span').first().textContent(),'所属 admin、dataset-browser-user');
  assert.ok(calls.some(call=>call.operation==='datasets.list'&&call.args.userId==='builtin-admin'&&call.args.hostAdmin===true));
  assert.equal(await admin.locator('#datasets-capacity strong').textContent(),'502 GiB');assert.equal(await admin.locator('#datasets-capacity small').textContent(),'共 1024 GiB');assert.match(await admin.locator('#datasets-capacity .ui-info-content').textContent(),/可用 512 GiB/);assert.match(await admin.locator('#datasets-capacity .ui-info-content').textContent(),/共享数据盘，容量不是个人配额/);
  assert.equal(await row(admin,'another').count(),1,'Same dataset and version is merged across machines');
  assert.equal(await admin.locator('#datasets-add').evaluate(node=>node.open),false,'Import controls start collapsed');
  assert.equal(await admin.locator('.dataset-cache-admin,[data-remove-more],[data-cache-pin-slot],#cloud-admin').count(),0,'Main view has no privileged storage actions');
  await capture(admin,'datasets-admin-desktop.png');
  phases.set('gpu-2','STAGING');await switchMachine(admin,'gpu-2');await selectDataset(admin,'another');
  assert.equal(await cache(admin,'another','gpu-2').isEnabled(),true,'Interrupted staging must remain resumable');
  assert.equal(await detail(admin).locator('[data-use-dataset="another"]').isEnabled(),true,'Approved interrupted staging can enter preparation-before-training');
  phases.set('gpu-2','READY');

  await login(member,'dataset-browser-user');await refresh(member);
  assert.deepEqual(await member.locator('[name=dataset-machine] option').evaluateAll(options=>options.map(option=>option.value)),['gpu-1','gpu-2']);
  assert.equal(await member.locator('[data-v3-select]').count(),2);
  assert.equal(await row(member,'admin-private').count(),0,'A private foreign dataset is omitted from the main list');
  assert.equal(await member.locator('[data-v3-select]').count(),2,'Only visible datasets contribute to the warehouse list');
  assert.equal(await member.locator('#page-title .v3-count').count(),0,'The storage heading has no dataset count');
  assert.ok(calls.some(call=>call.operation==='datasets.list'&&call.args.userId==='builtin-admin'&&call.args.hostAdmin===true));
  assert.equal(await member.locator('.v3-server-chip:not(.v3-all)').count(),MACHINES.length,'Metadata includes every inventory node while the execution selector stays quota-bound');
  const beforeTamper=calls.length;
  await member.evaluate(version=>{
    const root=document.querySelector('#page-datasets');
    for(const action of ['data-use-dataset','data-v3-cache']){
      const button=document.createElement('button');button.type='button';button.dataset.version=version;
      if(action==='data-use-dataset')button.setAttribute(action,'admin-private');
      else{button.setAttribute(action,'gpu-1');button.dataset.dataset='admin-private';}
      root.append(button);button.click();button.remove();
    }
  },'b'.repeat(64));
  assert.equal(await member.locator('#work-submit').isVisible(),false,'Delegated action rechecks authorization even if disabled DOM is removed');
  assert.equal(calls.length,beforeTamper,'An injected hidden version cannot request a catalog, prepare data or submit training');
  await selectDataset(member,'sample');
  assert.equal(await row(member,'sample').locator('.v3-owner').textContent(),'admin、dataset-browser-user');
  assert.equal(await row(member,'sample').locator('.v3-owner').getAttribute('title'),'所属 admin、dataset-browser-user');
  assert.equal(await detail(member).locator('.v3-meta>span').first().textContent(),'所属 admin、dataset-browser-user');
  assert.equal(await cache(member).isEnabled(),true);
  assert.equal(await detail(member).locator('[data-use-dataset]').isEnabled(),true);
  assert.equal(await detail(member).locator('[data-use-dataset]').textContent(),'用于训练');
  assert.equal(await detail(member).locator('.v3-code code').first().textContent(),'--data sample@'+version);
  assert.equal(await detail(member).locator('.v3-code code').last().textContent(),'/data2/sample');
  assert.equal(await detail(member).locator('.v3-lock').textContent(),'只读');
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
  await member.locator('[data-v3-upload]').first().click();
  await member.locator('#v3-file-picker').setInputFiles({name:'draft.txt',mimeType:'text/plain',buffer:Buffer.from('draft')});
  await member.locator('#v3-upload-display').fill('preserved-draft');
  await member.locator('[data-dataset-source=link]').click();
  await member.locator('[name=cloud-source]').selectOption('https');
  await member.locator('[name=cloud-url]').fill('https://example.invalid/dataset.zip');
  await member.locator('#dataset-organize-next').click();
  assert.equal(await member.locator('#dataset-panel-workspace').isVisible(),true);
  assert.match(await member.locator('#dataset-panel-workspace').textContent(),/不会自动解压/);
  assert.equal(await member.locator('#dataset-add-dialog #cloud-files-form').count(),1,'The import sheet preserves the private cloud file panel');
  assert.equal(await member.locator('#dataset-add-dialog [name=cloud-files-path]').count(),1);
  await member.locator('[data-dataset-source=directory]').click();
  assert.equal(await member.locator('#v3-upload-display').inputValue(),'preserved-draft');
  await member.locator('[data-dataset-source=link]').click();
  assert.equal(await member.locator('[name=cloud-url]').inputValue(),'https://example.invalid/dataset.zip');
  await member.locator('#dataset-source-link').press('ArrowRight');
  assert.equal(await member.locator('#dataset-source-workspace').getAttribute('aria-selected'),'true');
  assert.equal(calls.some(call=>/cloud\.(import|files\.(put|pull|begin))|workspace\.(put|publish)|datasets\.upload\.(begin|direct-ticket)|terminal.*open/.test(call.operation)),false,'Passive capability reads and selecting a source never imports, extracts, publishes, issues tickets or starts a terminal');
  await member.locator('[data-dataset-add-close]').click();
  assert.equal(await member.locator('#dataset-add-dialog').isVisible(),false,'The import sheet closes without discarding method drafts');
  await member.locator('[data-v3-upload]').first().click();
  await member.locator('#dataset-add-dialog').waitFor({state:'visible'});
  await member.evaluate(()=>{location.hash='work';});
  await member.locator('#page-work').waitFor({state:'visible'});
  await member.locator('#dataset-add-dialog').waitFor({state:'hidden'});
  assert.equal(await member.locator('#dataset-add-dialog').getAttribute('open'),null,'A room deep link closes the native sheet and releases background input');
  await member.locator('[data-nav=datasets]').click();
  await member.locator('[data-v3-upload]').first().click();
  await member.locator('#dataset-add-dialog').waitFor({state:'visible'});
  assert.equal(await member.locator('#v3-upload-display').inputValue(),'preserved-draft','Changing rooms keeps the upload draft');
  await member.locator('[data-dataset-add-close]').click();

  // Delay one machine's response: old machine entries must disappear immediately.
  let releaseList; listGate = new Promise(resolve => {releaseList = resolve;});
  const listStarted = new Promise(resolve => {waitingList = resolve;});
  await member.locator('#context-machine').selectOption('gpu-2'); await listStarted;
  assert.equal(await member.locator('[data-v3-select]').count(),0);assert.equal(await detail(member).locator('[data-use-dataset]:enabled').count(),0,'No stale inspector can submit during reload');
  assert.equal(await member.locator('[name=dataset-machine]').isDisabled(), true);
  releaseList(); listGate = null; waitingList = null;
  await row(member,'another').waitFor();await member.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);await selectDataset(member,'sample');
  assert.equal(await cache(member,'sample','gpu-2').isDisabled(),true,'Remote metadata without preparation rights cannot be cached');
  assert.equal(await detail(member).locator('[data-use-dataset]').isDisabled(),true,'Remote READY is not current-machine READY');
  await switchMachine(member,'gpu-1');await selectDataset(member,'sample');

  await prepare(member);
  assert.match(await detail(member).textContent(), /取回中/);
  assert.equal(service.store.jobs.length, 0, 'Preparing data must not reserve any GPU');
  phases.set('gpu-1', 'FAILED'); await refresh(member);
  assert.match(await detail(member).textContent(), /取回失败/);
  assert.match(await detail(member).textContent(), /Test preparation interrupted/);
  assert.equal(await cache(member).isEnabled(), true);
  assert.equal(await detail(member).locator('[data-use-dataset]').isDisabled(), true,'Failed data requires an explicit preparation retry, not another doomed training');
  await capture(member, 'datasets-member-failed-retry.png');
  await prepare(member);
  assert.equal(calls.filter(call => call.operation === 'datasets.prepare').length, 2);
  phases.set('gpu-1', 'READY'); await refresh(member);
  assert.equal(await cache(member).count(),0,'READY has no redundant cache button');
  assert.equal(await detail(member).locator('[data-use-dataset]').isEnabled(), true);

  await member.setViewportSize({width: 390, height: 844});
  await capture(member, 'datasets-member-mobile-ready.png');
  await member.screenshot({path:join(screenshots,'datasets-unified-mobile-viewport.png'),fullPage:false});
  const layout = await member.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
  assert.ok(layout.scroll <= layout.width + 1, `390px dataset page overflows: ${JSON.stringify(layout)}`);
  await selectDataset(member,'sample');await detail(member).locator('[data-use-dataset]').click();
  await member.locator('#work-submit').waitFor({state: 'visible'});
  assert.equal(await member.locator('#page-datasets').isVisible(),true,'Selecting a fixed dataset opens submission above the current room');
  assert.equal(await member.locator('#page-work').isVisible(),false,'Dataset selection preserves its page context');
  assert.equal(await member.locator('#train-form [name=machine]').inputValue(), 'gpu-1');
  assert.equal(await member.locator('#train-form [name=datasets]').inputValue(), 'sample@' + version);
  assert.equal(await member.locator('#train-form').evaluate(form => form.closest('details').open), true);
  await member.waitForFunction(() => document.querySelector('.training-read-mode').getAttribute('aria-busy') === 'false');
  if (legacyTrainingCapabilities) assert.equal(await member.locator('.training-read-mode').isHidden(), true);
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
  // Public login no longer probes authenticated state. All other HTTP and
  // console errors remain forbidden, including a pre-login 401.
  await Promise.all(trainingResponseChecks);
  for (const page of [admin, member]) {
    const expected = unsupportedTrainingResponses.filter(item => item.page === page).length;
    assert.ok(expected <= 1, 'Unknown training capability is probed at most once per login session');
    assert.ok(trainingConsoleErrors.filter(item => item.page === page).length <= expected, 'Each expected native 400 console entry must have an exact verified unsupported-operation response');
  }
  if (legacyTrainingCapabilities) assert.equal(unsupportedTrainingResponses.filter(item => item.page === member).length, 1, 'The legacy capability is actually probed once');
  assert.deepEqual(httpErrors, [], 'Unexpected HTTP errors');
  assert.deepEqual(errors, [], 'Unexpected browser errors');
  assert.deepEqual(blocked, [], 'Unexpected external requests');
  // Two explicit dataset choices: the newer choice must survive an older lookup.
  await member.locator('#close-submit').click();await member.locator('#work-submit').waitFor({state:'hidden'});
  moreLocalVersions=true;await refresh(member);
  await Promise.all([member.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='projects.list'&&response.request().postDataJSON()?.args.machine==='gpu-2'),member.locator('#context-machine').selectOption('gpu-2')]);
  await setDatasetMachine(member,'gpu-1');
  let notifyHeld,rejectHeld;const held=new Promise((resolve,reject)=>{notifyHeld=resolve;rejectHeld=reject;});
  await member.route('**/api/call',guardedRoute(async route=>{
    const request=route.request().postDataJSON();
    if(holdLookup&&request.operation==='projects.list'&&request.args.machine==='gpu-1'){
      holdLookup=false;let response;
      try{response=await route.fetch({timeout:10000});}catch(error){rejectHeld(error);await route.abort();return;}
      heldRequest=route.request();let complete;heldDelivery=new Promise(resolve=>{complete=resolve;});
      try{await new Promise(resolve=>{releaseLookup=resolve;notifyHeld();});await route.fulfill({response});}finally{complete();}
    }else await route.fallback();
  }));
  holdLookup=true;
  const chosen=async value=>{const [dataset,selectedVersion]=value.split('@');await selectDataset(member,dataset,selectedVersion);await detail(member).locator('[data-use-dataset]').click();};
  await chosen('sample@'+version);
  let heldTimeout;
  try{await Promise.race([held,new Promise((_,reject)=>{heldTimeout=setTimeout(()=>reject(new Error('The first dataset choice must request its server projects')),10000);})]);}
  finally{clearTimeout(heldTimeout);}
  if(await member.locator('#work-submit').isVisible()){await member.locator('#close-submit').click();await member.locator('#work-submit').waitFor({state:'hidden'});}
  const latest='sample@'+'d'.repeat(64);
  await chosen(latest);await member.locator('#work-submit').waitFor({state:'visible'});
  const before=await member.locator('#train-form [name=datasets]').inputValue();
  const delivered=heldDelivery;
  releaseLookup();await delivered;await member.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  const after=await member.locator('#train-form [name=datasets]').inputValue();
  assert.equal(before,latest,'The new choice is visible before the old reply arrives');
  assert.equal(after,latest,'An older server lookup must not replace the newer fixed dataset choice');

  // The same intent fence must also hold when the second choice changes node.
  await member.locator('#close-submit').click();await member.locator('#work-submit').waitFor({state:'hidden'});
  await Promise.all([member.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='projects.list'&&response.request().postDataJSON()?.args.machine==='gpu-2'),member.locator('#context-machine').selectOption('gpu-2')]);
  await setDatasetMachine(member,'gpu-1');
  const crossNodeHeld=new Promise(resolve=>{notifyHeld=resolve;});holdLookup=true;
  await chosen('sample@'+version);
  try{await Promise.race([crossNodeHeld,new Promise((_,reject)=>{heldTimeout=setTimeout(()=>reject(new Error('The cross-node first choice must request projects')),10000);})]);}
  finally{clearTimeout(heldTimeout);}
  await setDatasetMachine(member,'gpu-2');
  await row(member,'another').waitFor({state:'visible'});await member.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
  await chosen('another@'+version);await member.locator('#work-submit').waitFor({state:'visible'});
  // Context changes now abort fetch. Await the controlled fixture delivery,
  // then require cancellation as well as the original stale-intent assertions.
  const oldReply=heldDelivery;
  releaseLookup();await oldReply;await member.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  assert.ok((await heldRequest.response())===null,'switching server cancels the older lookup');assert.ok(heldRequest.failure());
  assert.equal(await member.locator('#train-form [name=machine]').inputValue(),'gpu-2','An old node lookup cannot restore its server');
  assert.equal(await member.locator('#train-form [name=datasets]').inputValue(),'another@'+version,'The newest node and fixed version remain paired');

  // Native/programmatic close must cancel pending selection, not only its button.
  await member.locator('#close-submit').click();await member.locator('#work-submit').waitFor({state:'hidden'});
  await setDatasetMachine(member,'gpu-1');
  const closedHeld=new Promise(resolve=>{notifyHeld=resolve;});holdLookup=true;
  // The existing submit sheet is modal, so use the same delegated UI event as
  // the real dataset button without changing the sheet's native close behavior.
  await member.evaluate(ref=>document.dispatchEvent(new CustomEvent('gpuq-open-submit',{detail:{machine:'gpu-1',datasetRef:ref}})),'sample@'+version);
  try{await Promise.race([closedHeld,new Promise((_,reject)=>{heldTimeout=setTimeout(()=>reject(new Error('The close-race choice must request projects')),10000);})]);}
  finally{clearTimeout(heldTimeout);}
  // close() on a closed dialog is a no-op; establish the actual native transition.
  await member.evaluate(()=>document.querySelector('#work-submit').showModal());
  assert.equal(await member.locator('#work-submit').evaluate(dialog=>dialog.open),true,'Native-close fixture starts open');
  await member.evaluate(()=>document.querySelector('#work-submit').close());await member.locator('#work-submit').waitFor({state:'hidden'});
  const closedReply=heldDelivery;
  releaseLookup();await closedReply;await member.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  assert.ok((await heldRequest.response())===null,'native close cancels the pending lookup');assert.ok(heldRequest.failure());
  assert.equal(await member.locator('#work-submit').isVisible(),false,'A late lookup must not reopen a generically closed submit sheet');
  await Promise.all(trainingResponseChecks);
  for (const page of [admin, member]) assert.ok(trainingConsoleErrors.filter(item => item.page === page).length <= unsupportedTrainingResponses.filter(item => item.page === page).length, 'No unrelated console resource failure is allowed');
  if (legacyTrainingCapabilities) {
    for (const page of [admin, member]) assert.ok(requests.filter(item => item.page === page && item.operation === 'datasets.training.capabilities').length <= 1, 'Changing version/node or reopening submission never repeats an unavailable capability read');
    assert.equal(await member.locator('.training-read-mode').isHidden(), true);
  }
  assert.deepEqual(httpErrors, [], 'Unexpected HTTP errors after repeated submission choices');
  assert.deepEqual(errors, [], 'Unexpected browser errors after repeated submission choices');
  console.log('DATASETS UI PASS: full metadata catalogs with explicit owner-use gates; capacity is not personal quota; collapsed three-source import with draft preservation, keyboard tabs and no implicit actions; authorized machine choices; remote READY never unlocks current-machine training; no stale catalog on machine switch; registered → prepare → failed → retry → ready; exact immutable ref and jobspec; 390px layout; legacy training capability probes at most once, zero unexpected HTTP or browser errors and no external requests.');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  holdLookup=false;releaseLookup?.();
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(dir, {recursive: true, force: true});
}

// Keep all existing protocol and authorization assertions above. The extended
// local fixture exercises database/cache facts, admin retention and layout.
await import('./dataset-flow-browser-fixture.mjs');

// Exercise the actual overview renderer in addition to legacy protocol fallback.
await import('./dataset-capacity-ui-smoke.mjs');

// Strict new cache capability and receipt integration in the actual warehouse.
await import('./dataset-warehouse-cache-ui-smoke.mjs');

// A readable same-node warehouse original permits logical cache preparation,
// without advertising a READY cache before its actual node receipt.
await import('./warehouse-logical-cache-ui-smoke.mjs');
await import('./dataset-cache-operation-ui-smoke.mjs');
await import('./dataset-files-preview-ui-smoke.mjs');
