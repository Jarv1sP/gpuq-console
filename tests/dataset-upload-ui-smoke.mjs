// Real Chromium, real browser hashing/upload/UI code, in-memory authenticated
// store and transfer peer. Every resource is intercepted locally: no sockets,
// SSH, production accounts, external requests or GPU jobs are used.
// CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
//   node tests/dataset-upload-ui-smoke.mjs
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';
import {inspectGeometry} from './layout-geometry.mjs';
import {datasetHelpGeometry} from './dataset-help-geometry.mjs';
import {testArchiveUpload} from './dataset-archive-upload-ui-smoke.mjs';

const origin = 'https://offline-dataset-upload.test';
const screenshots = process.env.UI_SCREENSHOTS || '/tmp/gpuq-dataset-upload-ui';
const dataDirectory = await mkdtemp(join(tmpdir(), 'gpuq-upload-selection-'));
const browser = await chromium.launch({headless: true,
  ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
const errors = [], unexpected = [];
try {
  await mkdir(screenshots, {recursive: true});
  await mkdir(join(dataDirectory, 'nested'));
  await writeFile(join(dataDirectory, 'nested', 'samples.bin'),
    Uint8Array.from({length: 2 * 1024 ** 2 + 33}, (_, index) => index % 251));
  await writeFile(join(dataDirectory, 'empty'), '');
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      unexpected.push(url.href); return route.abort('blockedbyclient');
    }
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: `<!doctype html>
      <html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/datasets.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/copy-help.css"><link rel="stylesheet" href="/dataset-flow.css"><link rel="stylesheet" href="/dataset-warehouse.css"></head>
      <body class="sb" data-room="datasets"><main id="main-content"><div class="page-heading"><div><h1 id="page-title">数据集</h1></div><div class="heading-actions"></div></div>
      <section id="page-datasets"></section><button data-nav="work" hidden>工作台</button>
      <details hidden><form id="train-form"><select name="machine"><option>gpu-1</option><option>gpu-2</option></select>
      <input name="datasets"><input name="command"></form></details></main></body></html>`});
    const names = new Set(['/member-storage-model.js','/member-storage-ui.js','/dataset-catalog-model.js','/dataset-label-client.js','/dataset-warehouse-view.js','/dataset-files-preview.js','/dataset-upload-metrics.js','/dataset-warehouse.css','/dataset-flow.js','/dataset-cache-admin.js','/manual-pin-state.js','/maintenance-state.js','/copy-help-ui.js','/copy-help.css','/datasets-ui.js','/dataset-remove-ui.js','/dataset-full-delete-ui.js','/dataset-full-delete-state.js','/dataset-remove.css','/workbench-ui.js','/job-progress.js','/motion-ui.js', '/data-route.js', '/dataset-upload.js', '/upload-routes.js', '/data-workspace.js', '/cloud-files-ui.js', '/transfer-upload.js','/cloud-import-ui.js', '/styles.css', '/workspace.css', '/datasets.css']);
    if(url.pathname==='/capabilities')return route.fulfill({contentType:'application/json',body:JSON.stringify({protocol:'dataset-upload-v1',machine:'gpu-1',revision:'a'.repeat(64),listenerReady:await page.evaluate(()=>window.probeReady===true)})});
    if(url.pathname.startsWith('/v1/uploads/')){
      const action=url.pathname.split('/').at(-1),uploadId=url.pathname.split('/')[3],bytes=route.request().postDataBuffer();
      const args={machine:'gpu-1',uploadId,...Object.fromEntries(url.searchParams),...(['manifest','chunk'].includes(action)?{data:(bytes||Buffer.alloc(0)).toString('base64')}:{})};if(args.offset!==undefined)args.offset=Number(args.offset);
      const result=await page.evaluate(async({action,args})=>store.call('datasets.upload.'+action,args,true),{action,args});
      try{return await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result})});}catch(error){if(!/closed|handled|intercepted/i.test(error.message))throw error;return;}
    }
    if (names.has(url.pathname)||Object.hasOwn(STARBASE_ASSETS,url.pathname)) return route.fulfill({
      contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.woff2')?'font/woff2':'text/css',
      body: await readFile(new URL('../dist' + url.pathname, import.meta.url))});
    if (url.pathname === '/favicon.ico') return route.fulfill({status: 204});
    unexpected.push(url.href); return route.abort('blockedbyclient');
  });
  await page.goto(origin);
  await page.evaluate(async () => {
    const {datasetsUI} = await import('/datasets-ui.js');
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const decode = data => Uint8Array.from(atob(data), char => char.charCodeAt(0));
    const concat = (first, second) => {const out = new Uint8Array(first.length + second.length); out.set(first); out.set(second, first.length); return out;};
    const check = (condition, message) => {if (!condition) throw Error(message);};
    window.calls = []; window.toasts = []; window.uploads = new Map();window.names=new Map();window.admissions=new Map();
    window.gates = {chunk: true, begin: false, publish: true};
    const describe = upload => ({uploadId: upload.id, name: upload.name, state: upload.state,placementProtocol:1,requestedMachine:upload.spec.machine,storageMachine:'gpu-1',storageTier:'hdd',legacyPlacement:false,
      manifestOffset: upload.manifest.length, manifestBytes: upload.spec.manifestBytes,
      totalBytes: upload.spec.totalBytes, entries: upload.spec.entries,
      uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true,routeSelection:true},
      ...(upload.version ? {dataset: upload.dataset, version: upload.version} : {})});
    window.store = {production: true, principal: {userId: 'old-user', role: 'member'}, authGeneration: 0,
      users: ['old-user','new-user'].map(id => ({id,role:'member',enabled:true,limits:{'gpu-1':1,'gpu-2':1},total:2})),
      usage() {return 0;},
      data: {machines: [{id: 'gpu-1'}, {id: 'gpu-2'}],datasetUploadAdmission:{protocol:1,available:true}},
      listeners:[],onAuthChange(listener) {this.listeners.push(listener);},
      async call(operation, args, campus=false) {
        const user = this.principal.userId;
        calls.push({operation, args: structuredClone(args), user,transport:campus?'campus':'portal'});
        check(campus||!['datasets.upload.manifest','datasets.upload.chunk'].includes(operation),'Browser bytes never use Portal relay');
        if(operation==='cloud.info')return {capabilityVerified:false,configurationEnabled:true};
        if(operation==='datasets.catalog'&&args.machine===null){
          check(Object.keys(args).length===1,'No identity override on a read-only catalog');
          return {machine:null,machines:[],datasets:[]};
        }
        check(['gpu-1','gpu-2'].includes(args.machine), 'Read belongs to a known machine');
        check(!('hostAdmin' in args || 'owners' in args || 'sourceId' in args), 'Privileged browser upload fields');
        if (operation === 'datasets.capacity') return {machine:args.machine,available:true,filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3};
        if (operation === 'datasets.upload.routes')return {available:true,protocol:'dataset-upload-v1',machine:args.machine,revision:'a'.repeat(64),certificateSha256:'b'.repeat(64),routes:[{id:'primary',kind:'campus-direct',endpoint:location.origin}]};
        if (operation === 'datasets.overview') {if(Object.keys(args).length)throw Error('Unexpected overview args');return {protocol:0};}
        if (operation === 'datasets.catalog') return {machine:args.machine,
          machines:this.data.machines.map(row=>({machine:row.id,state:'ok'})),datasets: [...uploads.values()]
          .filter(upload => upload.user === user && upload.state === 'READY')
          .map(upload => ({dataset: upload.dataset, name: upload.name,
            versions: [{version: upload.version, state: 'READY', files: upload.parsed.files.length,
              bytes: upload.spec.totalBytes, canUse:true, canPrepare: false,
              locations:[{machine:upload.spec.machine,dataset:upload.dataset,state:'READY',canUse:true,canPrepare:false}]}]}))};
        if(operation==='datasets.label.get'){const label=names.get(args.dataset)||{displayName:null,revision:0};return {dataset:args.dataset,name:label.displayName??args.dataset,...label,scope:'personal',ownerId:user};}
        if(operation==='datasets.label.set'){const old=names.get(args.dataset)||{revision:0};check(args.revision===old.revision,'Display label CAS');const label={displayName:args.displayName,revision:old.revision+1};names.set(args.dataset,label);return {dataset:args.dataset,name:label.displayName??args.dataset,...label,scope:'personal',ownerId:user};}
        check(args.machine==='gpu-1','Selected machine drifted during upload');
        if(operation==='datasets.upload.admission.create'||operation==='datasets.upload.admission.status'){
          const key=user+':'+args.key;let receipt=admissions.get(key);
          if(operation.endsWith('.create')){const specification=Object.fromEntries(['name','manifestBytes','manifestSha256','totalBytes','entries'].map(field=>[field,args[field]]));if(!receipt){receipt={protocol:'dataset-upload-admission-v1',key:args.key,uploadId:crypto.randomUUID(),requestedMachine:args.machine,storageMachine:'gpu-1',storageTier:'hdd',specification,state:'ISSUED'};admissions.set(key,receipt);}check(JSON.stringify(receipt.specification)===JSON.stringify(specification),'Admission specification changed');const saved=JSON.parse(localStorage.getItem('gpuq.dataset-upload.intent.'+args.key));check(saved?.userId===user&&saved.key===args.key,'Admission intent must be durably remembered by this account');}
          check(receipt,'Original admission must exist');return receipt;
        }
        const action = operation.split('.').at(-1);
        let upload;
        if (action === 'begin') {
          const receipt=[...admissions.entries()].find(([key,row])=>key.startsWith(user+':')&&row.uploadId===args.key)?.[1];check(receipt,'Begin requires this owner’s issued UUID');
          const saved=JSON.parse(localStorage.getItem('gpuq.dataset-upload.intent.'+receipt.key));check(saved?.uploadId===args.key&&saved.beginAttempted===true,'Issued UUID must be durably remembered before begin');
          const key = user + ':' + args.key;
          upload = uploads.get(key);
          if (!upload) {
            upload = {id: args.key, user, name: args.name, spec: args, manifest: new Uint8Array(),
              state: 'RECEIVING_MANIFEST', files: new Map()}; uploads.set(key, upload);
          }
          if (gates.begin) await new Promise(resolve => {window.releaseBegin = resolve;});
          return describe(upload);
        }
        upload = [...uploads.values()].find(item => item.id === args.uploadId && item.user === user);
        check(upload, 'Upload must belong to the current caller');
        if(action==='direct-ticket')return {available:true,protocol:'dataset-upload-v1',machine:'gpu-1',revision:'a'.repeat(64),certificateSha256:'b'.repeat(64),endpoint:location.origin,routeId:'primary',kind:'campus-direct',ticket:'fixture-only-campus-ticket',expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:1024**2};
        if (action === 'manifest') {
          const bytes = decode(args.data); check(bytes.length <= 1024 ** 2, 'Unbounded manifest chunk');
          check(args.offset === upload.manifest.length, 'Unexpected manifest offset');
          upload.manifest = concat(upload.manifest, bytes); return {...describe(upload), offset: upload.manifest.length};
        }
        if (action === 'seal') {
          check(await hash(upload.manifest) === upload.spec.manifestSha256, 'Manifest SHA256 differs');
          upload.parsed = JSON.parse(new TextDecoder().decode(upload.manifest));
          check(upload.parsed.files.length + upload.parsed.directories.length === upload.spec.entries, 'Manifest totals differ');
          upload.state = 'UPLOADING'; return describe(upload);
        }
        if (action === 'status') {
          if (upload.state === 'PUBLISHING' && !gates.publish) upload.state = 'READY';
          const result = describe(upload);
          if (args.path) {
            const entry = upload.parsed.files.find(file => file.path === args.path), bytes = upload.files.get(args.path);
            check(entry, 'Status outside sealed manifest');
            result.file = {...entry, offset: bytes?.length || 0, complete: !!bytes && bytes.length === entry.size};
          }
          return result;
        }
        if (action === 'chunk') {
          const entry = upload.parsed.files.find(file => file.path === args.path), bytes = decode(args.data);
          const previous = upload.files.get(args.path) || new Uint8Array();
          check(entry && bytes.length <= 1024 ** 2, 'Unbounded or unlisted file chunk');
          check(args.offset === previous.length && args.offset + bytes.length <= entry.size, 'Invalid file offset');
          const current = concat(previous, bytes); upload.files.set(args.path, current);
          if (gates.chunk && bytes.length) {gates.chunk = false; await new Promise(resolve => {window.releaseChunk = resolve;});}
          return {...describe(upload), offset: current.length, complete: current.length === entry.size};
        }
        if (action === 'commit') {
          for (const entry of upload.parsed.files) {
            const bytes = upload.files.get(entry.path);
            check(bytes && bytes.length === entry.size && await hash(bytes) === entry.sha256, 'Unverified payload cannot publish');
          }
          upload.version = await hash(upload.manifest); upload.dataset = 'u-0123456789abcdef-' + upload.name;
          upload.state = 'PUBLISHING'; return describe(upload);
        }
        throw Error('Unexpected operation ' + operation);
      }};
    window.renderDatasets = datasetsUI(store, value => toasts.push(value)); renderDatasets();
  });
  await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
  await page.locator('[data-v3-upload]').first().click();
  // The policy supplies a physical destination, not a replacement for the
  // authorized requestedMachine or a new upload permission.
  const requested=page.locator('[name=dataset-machine]');
  for(const admission of [undefined,{available:true},{available:true,targetMachine:null},{available:true,targetMachine:''},{available:true,targetMachine:' '},{available:false,targetMachine:'gpu-1'}]){
    await page.evaluate(admission=>{store.data.datasetUploadAdmission=admission;renderDatasets();},admission);
    assert.equal(await page.locator('#v3-upload-target').count(),0);
    assert.equal(await requested.evaluate(node=>node.closest('.server-select').hidden),false);
    assert.deepEqual(await requested.locator('option').evaluateAll(nodes=>nodes.map(node=>node.value)),['gpu-1','gpu-2']);
  }
  await page.evaluate(()=>{store.data.datasetUploadAdmission={protocol:1,available:true,targetMachine:'gpu-2'};renderDatasets();});
  const fixed=page.locator('#v3-upload-target');
  assert.equal(await fixed.isDisabled(),true);assert.equal(await fixed.inputValue(),'gpu-2');
  assert.deepEqual(await fixed.locator('option').evaluateAll(nodes=>nodes.map(node=>node.value)),['gpu-2']);
  assert.equal(await fixed.getAttribute('title'),'gpu-2');
  assert.equal(await page.locator('#datasets-capacity').isHidden(),true,'The original training cache capacity is not a warehouse measurement');
  assert.equal(await page.locator('#v3-upload-capacity').textContent(),'仓库');
  assert.equal(await requested.inputValue(),'gpu-1','Display target cannot rewrite the authorized training selection');
  assert.equal(await requested.evaluate(node=>node.closest('.server-select').hidden),true);
  await page.evaluate(()=>{store.users.find(user=>user.id===store.principal.userId).limits={'gpu-1':0,'gpu-2':0};renderDatasets();});
  await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
  assert.equal(await fixed.inputValue(),'gpu-2');assert.equal(await fixed.isDisabled(),true);
  assert.equal(await page.locator('#dataset-upload-start').isDisabled(),true,'A policy target supplies no upload permission');
  assert.equal(await requested.inputValue(),'','No authorized requestedMachine can be invented');
  await page.evaluate(()=>{store.users.find(user=>user.id===store.principal.userId).limits={'gpu-1':1,'gpu-2':1};renderDatasets();});
  await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
  await page.keyboard.press('Escape');await page.locator('#dataset-add-dialog').waitFor({state:'hidden'});
  await page.locator('[data-v3-upload]').first().click();
  await page.evaluate(()=>{store.data.datasetUploadAdmission={protocol:1,available:true,targetMachine:'gpu-1'};renderDatasets();});
  assert.equal(await fixed.inputValue(),'gpu-1');assert.equal(await fixed.isDisabled(),true);
  assert.equal(await page.evaluate(()=>calls.some(row=>row.operation.startsWith('datasets.upload.')&&row.operation!=='datasets.upload.routes')),false,'Rendering a fixed target sends no upload writes');
  async function assertUploadLayout(mobile = false) {
    await page.evaluate(()=>document.fonts.ready);
    const result=await inspectGeometry(page,{...datasetHelpGeometry,roots:['#dataset-add-dialog'],scrollPanels:['#dataset-add-dialog']});
    assert(result.pass,JSON.stringify({failures:result.failures,layout:await page.evaluate(()=>({container:document.querySelector('#page-datasets').getBoundingClientRect().width,type:getComputedStyle(document.querySelector('#page-datasets')).containerType,buttons:[...document.querySelectorAll('#dataset-add-dialog button')].filter(node=>node.getBoundingClientRect().height>0).map(node=>({text:node.textContent,height:node.getBoundingClientRect().height,min:getComputedStyle(node).minHeight}))}))}));
    const layout=await page.evaluate(()=>{const box=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();return {width:innerWidth,scroll:document.documentElement.scrollWidth,form:box('#dataset-upload-form'),title:box('#dataset-add-title'),help:box('[data-dataset-help-source=directory] [data-copy-help]'),helpText:document.querySelector('[data-dataset-help-source=directory] .copy-help-popup>p').textContent,notes:document.querySelectorAll('.dataset-upload-notes').length};});
    assert(layout.scroll<=layout.width+1,'The real dialog must not overflow the viewport');
    assert(layout.form.width<=800,'Upload has a bounded readable width');
    assert.equal(layout.notes,0,'No orphan explanation row');
    assert(layout.help.left>=layout.title.right-1,'Hint belongs to the title row on its right');
    assert(Math.abs(layout.help.y+layout.help.height/2-layout.title.y-layout.title.height/2)<=1,'Hint shares the title centre');
    assert.equal(layout.helpText,'关闭页面会暂停传输；重新选择同一目录可继续。已开始的服务器校验不受影响。');
    assert.equal(await page.locator('.dataset-upload-fields:visible').count(),0,'Native legacy form controls do not replace the single-column upload view');
    if(mobile)for(const button of await page.locator('#dataset-upload-form .button:visible').all())assert((await button.boundingBox()).height>=44,'Visible upload actions retain touch size');
  }
  await page.locator('[name=dataset-directory]').setInputFiles(dataDirectory);
  await page.locator('#v3-upload-display').fill('browser-data');
  const fileButtonContrast = await page.locator('[data-v3-reselect]').evaluate(button => {
    const style = getComputedStyle(button);
    const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(Number)
      .map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
  });
  assert.ok(fileButtonContrast >= 4.5, 'Visible Chinese file selector label must retain AA contrast');
  assert.equal(await page.locator('#dataset-add-dialog .data-eyebrow').count(),0);
  assert.equal(await page.locator('[data-v3-reselect]').textContent(),'更换');
  assert.match(await page.locator('#dataset-directory-selection').textContent(),/^已选 2 个文件 · 共 /);
  for(const id of ['dataset-name-help','dataset-directory-help']){
    assert.equal(await page.locator('#'+id).evaluate(note=>note.closest('.ui-info').parentElement.className),'dataset-field-label','Help belongs beside its field label');
  }
  const input=page.locator('[name=dataset-directory]');
  assert.equal(await input.evaluate(node=>getComputedStyle(node).clipPath),'inset(50%)','Native English picker stays visually hidden');
  const picker=page.waitForEvent('filechooser');await page.locator('[data-v3-reselect]').click();
  assert.equal((await picker).isMultiple(),true,'Chinese label opens the folder picker');
  await page.locator('[data-v3-reselect]').focus();const keyboardPicker=page.waitForEvent('filechooser');await page.locator('[data-v3-reselect]').press('Enter');
  assert.equal((await keyboardPicker).isMultiple(),true,'Folder picker remains keyboard accessible');
  await assertUploadLayout();
  await page.screenshot({path: join(screenshots, 'upload-selection-desktop.png'), fullPage: true});
  await page.waitForFunction(()=>document.querySelector('#dataset-add-dialog').dataset.v3UploadState==='error');
  assert.equal(await page.locator('#v3-upload-state h3').textContent(),'仅校内网络可上传');
  assert.equal(await page.locator('#dataset-upload-start').isDisabled(),true);
  assert.equal(await page.locator('#v3-relay-options,[data-v3-explicit-relay],[name=dataset-relay-consent]').count(),0);
  assert.equal(await page.locator('[data-v3-cloud]').count(),0,'Connection failure never recommends a cloud import route');
  assert.equal(await page.locator('[data-v3-source=aliyun]').count(),1,'Cloud import remains available under the original other-source entry');
  assert.equal(await page.locator('[data-upload-phase][aria-current]').count(),0,'No progress before a real upload event');
  // A failed campus probe denies every size before begin or byte transmission.
  const beforeLarge=await page.evaluate(()=>calls.filter(row=>row.operation.startsWith('datasets.upload.')&&row.operation!=='datasets.upload.routes').length);
  await input.evaluate(input=>{Object.defineProperty(input.files[0],'size',{value:256*1024**2+1,configurable:true});input.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.locator('#dataset-upload-start').isDisabled(),true);
  await page.locator('#dataset-upload-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>toasts.length>0);
  assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation.startsWith('datasets.upload.')&&row.operation!=='datasets.upload.routes').length),beforeLarge,'No admission, begin, ticket or bytes when campus is unreachable');
  await input.evaluate(input=>{delete input.files[0].size;});
  await page.evaluate(()=>{probeReady=true;toasts.length=0;});
  await page.locator('#v3-upload-state [data-v3-probe]').click();
  await page.waitForFunction(()=>document.querySelector('#v3-upload-route').classList.contains('ok'));
  await page.locator('#dataset-upload-start').click();
  await page.waitForFunction(() => typeof window.releaseChunk === 'function');
  assert.equal(await page.evaluate(()=>Object.hasOwn(calls.find(c=>c.operation==='datasets.upload.begin').args,'allowRelay')),false);
  assert.equal(await page.locator('[data-upload-phase][aria-current]').getAttribute('data-upload-phase'),'transfer');
  assert.equal(await page.locator('[name=dataset-machine]').isDisabled(), true);
  await page.evaluate(() => {
    window.originalForm = document.querySelector('#dataset-upload-form');
    window.originalStatus = document.querySelector('#dataset-upload-status').textContent;
    store.data = {machines: [{id: 'gpu-1', freeCards: 0}, {id: 'gpu-2', freeCards: 4}],datasetUploadAdmission:{protocol:1,available:true}}; renderDatasets();
  });
  assert.equal(await page.evaluate(() => document.querySelector('#dataset-upload-form') === originalForm), true);
  assert.equal(await page.evaluate(() => document.querySelector('[name=dataset-directory]').files.length), 2);
  assert.equal(await page.evaluate(() => document.querySelector('#dataset-upload-status').textContent === originalStatus), true);
  await assertUploadLayout();
  await page.screenshot({path: join(screenshots, 'upload-progress-desktop.png'), fullPage: true});

  // Pause after the peer durably accepts a chunk but before its response arrives.
  const beforePause = await page.evaluate(() => calls.length);
  await page.locator('#dataset-upload-pause').click(); await page.evaluate(() => releaseChunk());
  await page.waitForFunction(() => !document.querySelector('[data-v3-probe]').disabled&&document.querySelector('#dataset-add-dialog').dataset.v3UploadState==='error');
  assert.equal(await page.evaluate(() => calls.length), beforePause);
  assert.match(await page.locator('#dataset-upload-status').textContent(), /暂停/);
  await page.setViewportSize({width: 390, height: 844});
  await assertUploadLayout(true);
  await page.screenshot({path: join(screenshots, 'upload-paused-mobile.png'), fullPage: true});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Paused upload overflows 390px');
  // A server message may contain an unbroken file path or immutable version.
  // Exercise text wrapping independently without changing the upload session.
  const pausedStatus = await page.locator('#dataset-upload-status').textContent();
  await page.locator('#dataset-upload-status').evaluate(node => {node.textContent = '校验文件 · training-data/' + 'very-long-file-name-'.repeat(12) + '.bin · ' + 'a'.repeat(64);});
  await assertUploadLayout(true);
  await page.screenshot({path: join(screenshots, 'upload-long-status-mobile.png'), fullPage: true});
  await page.locator('#dataset-upload-status').evaluate((node, text) => {node.textContent = text;}, pausedStatus);
  const resumeAt = await page.evaluate(() => calls.length);
  await page.locator('[data-v3-resume]').click();
  await page.waitForFunction(() => calls.some(call => call.operation === 'datasets.upload.commit'));
  assert.equal(await page.evaluate(() => uploads.size), 1);
  assert.equal(await page.evaluate(at => calls.slice(at).find(call => call.operation === 'datasets.upload.chunk').args.offset, resumeAt), 1024 ** 2);
  assert.equal(await page.evaluate(at => calls.slice(at).some(call => call.operation === 'datasets.upload.manifest'), resumeAt), false);
  assert.match(await page.locator('#dataset-upload-status').textContent(), /校验/);
  assert.equal(await page.locator('#dataset-upload-start').isDisabled(), true);
  await assertUploadLayout(true);
  await page.screenshot({path: join(screenshots, 'upload-publishing-mobile.png'), fullPage: true});
  await page.evaluate(() => {gates.publish = false;});
  await page.waitForFunction(() => document.querySelector('#dataset-add-dialog').dataset.v3UploadState==='complete');
  assert.equal(await page.locator('#v3-upload-state [data-use-dataset]').isEnabled(), true);
  assert.equal(await page.locator('[data-upload-phase][aria-current]').getAttribute('data-upload-phase'),'ready');
  const prepare = page.locator('[data-prepare-dataset]');
  assert.ok(!(await prepare.count()) || await prepare.isDisabled(), 'Personal data must not offer public-source prepare');
  assert.equal(await page.evaluate(() => toasts.length), 1);
  const reference = await page.locator('#v3-upload-state [data-use-dataset]').evaluate(node=>node.dataset.useDataset+'@'+node.dataset.version);
  assert.match(reference,/^u-0123456789abcdef-data-[a-f0-9]{24}@[a-f0-9]{64}$/);
  assert.equal(await page.evaluate(()=>names.get([...uploads.values()][0].dataset).displayName),'browser-data','Personal display name uses CAS and leaves the server ID immutable');
  await assertUploadLayout(true);
  await page.screenshot({path: join(screenshots, 'upload-ready-mobile.png'), fullPage: true});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'READY upload overflows 390px');

  // A late old-account begin cannot send data using the new account or refill UI.
  await page.evaluate(() => {gates.begin = true;});
  await page.locator('[data-v3-again]').click();
  await page.locator('[name=dataset-directory]').setInputFiles(dataDirectory);
  await page.locator('#v3-upload-display').fill('late-old-data');
  await page.waitForFunction(()=>document.querySelector('#v3-upload-route').classList.contains('ok'));
  await page.locator('#dataset-upload-start').click();
  await page.waitForFunction(() => typeof window.releaseBegin === 'function');
  const beforeSwitch = await page.evaluate(() => calls.filter(row=>row.operation.startsWith('datasets.upload.')&&row.operation!=='datasets.upload.routes').length);
  await page.evaluate(() => {
    store.authGeneration++; store.principal = {userId: 'new-user', role: 'member'};
    store.listeners.forEach(listener=>listener()); renderDatasets(); releaseBegin();
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => calls.filter(row=>row.operation.startsWith('datasets.upload.')&&row.operation!=='datasets.upload.routes').length), beforeSwitch,'Late old-account begin causes zero further upload writes');
  assert.equal(await page.locator('[name=dataset-name]').inputValue(), '');
  assert.equal(await page.evaluate(() => document.querySelector('[name=dataset-directory]').files.length), 0);
  assert.equal(await page.locator('#dataset-upload-progress').isHidden(), true);
  assert.equal(await page.locator('#dataset-upload-start').isEnabled(), false,'New account has no selected files or verified route');
  assert.doesNotMatch(await page.locator('#page-datasets').textContent(), /late-old-data|browser-data@/);
  assert.equal(await page.evaluate(() => toasts.length), 1);
  assert.equal(await page.locator('#v3-upload-state [data-use-dataset]').count(),0,'Old READY cannot be inherited by the new account');
  assert.equal(await page.evaluate(()=>calls.some(row=>row.transport==='portal'&&['datasets.upload.manifest','datasets.upload.chunk','datasets.workspace.put','datasets.workspace.get'].includes(row.operation))),false);
  await testArchiveUpload(page,screenshots);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('DATASET UPLOAD UI PASS: browser hashes and uploads exact bounded bytes; resource refresh preserves file selection/progress; pause after durable write resumes at confirmed offset; empty files survive; server verification precedes READY; bounded desktop card, separated actions, 390px stacked fields and long-status wrapping; late old-account response cannot send more data or update the new UI; no external requests or browser errors.');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await rm(dataDirectory, {recursive: true, force: true});
}

// Keep the HTTPS contract coverage in the existing CI browser entry point.
await import('./browser-direct-upload-browser.mjs');
