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
      <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace.css"></head>
      <body><main><div class="page-heading"><div><h1>数据集</h1><p>本地浏览器验收</p></div></div>
      <section id="page-datasets"></section><button data-nav="work" hidden>工作台</button>
      <details hidden><form id="train-form"><select name="machine"><option>gpu-1</option><option>gpu-2</option></select>
      <input name="datasets"><input name="command"></form></details></main></body></html>`});
    const names = new Set(['/datasets-ui.js', '/dataset-upload.js', '/styles.css', '/workspace.css']);
    if (names.has(url.pathname)) return route.fulfill({
      contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css',
      body: await readFile(new URL('../dist' + url.pathname, import.meta.url), 'utf8')});
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
    window.calls = []; window.toasts = []; window.uploads = new Map();
    window.gates = {chunk: true, begin: false, publish: true};
    const describe = upload => ({uploadId: upload.id, name: upload.name, state: upload.state,
      manifestOffset: upload.manifest.length, manifestBytes: upload.spec.manifestBytes,
      totalBytes: upload.spec.totalBytes, entries: upload.spec.entries,
      ...(upload.version ? {dataset: upload.dataset, version: upload.version} : {})});
    window.store = {production: true, principal: {userId: 'old-user', role: 'member'}, authGeneration: 0,
      data: {machines: [{id: 'gpu-1'}, {id: 'gpu-2'}]},
      onAuthChange(listener) {this.listener = listener;},
      async call(operation, args) {
        const user = this.principal.userId;
        calls.push({operation, args: structuredClone(args), user});
        check(args.machine === 'gpu-1', 'Selected machine drifted during upload');
        check(!('hostAdmin' in args || 'owners' in args || 'sourceId' in args), 'Privileged browser upload fields');
        if (operation === 'datasets.list') return {datasets: [...uploads.values()]
          .filter(upload => upload.user === user && upload.state === 'READY')
          .map(upload => ({dataset: upload.dataset, name: upload.name,
            versions: [{version: upload.version, state: 'READY', files: upload.parsed.files.length,
              bytes: upload.spec.totalBytes, canPrepare: false}]}))};
        const action = operation.split('.').at(-1);
        let upload;
        if (action === 'begin') {
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
  await page.locator('[name=dataset-name]').fill('browser-data');
  await page.locator('[name=dataset-directory]').setInputFiles(dataDirectory);
  await page.locator('#dataset-upload-start').click();
  await page.waitForFunction(() => typeof window.releaseChunk === 'function');
  assert.equal(await page.locator('[name=dataset-machine]').isDisabled(), true);
  await page.evaluate(() => {
    window.originalForm = document.querySelector('#dataset-upload-form');
    window.originalStatus = document.querySelector('#dataset-upload-status').textContent;
    store.data = {machines: [{id: 'gpu-1', freeCards: 0}, {id: 'gpu-2', freeCards: 4}]}; renderDatasets();
  });
  assert.equal(await page.evaluate(() => document.querySelector('#dataset-upload-form') === originalForm), true);
  assert.equal(await page.evaluate(() => document.querySelector('[name=dataset-directory]').files.length), 2);
  assert.equal(await page.evaluate(() => document.querySelector('#dataset-upload-status').textContent === originalStatus), true);
  await page.screenshot({path: join(screenshots, 'upload-progress-desktop.png'), fullPage: true});

  // Pause after the peer durably accepts a chunk but before its response arrives.
  const beforePause = await page.evaluate(() => calls.length);
  await page.locator('#dataset-upload-pause').click(); await page.evaluate(() => releaseChunk());
  await page.waitForFunction(() => !document.querySelector('#dataset-upload-start').disabled);
  assert.equal(await page.evaluate(() => calls.length), beforePause);
  assert.match(await page.locator('#dataset-upload-status').textContent(), /暂停/);
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: join(screenshots, 'upload-paused-mobile.png'), fullPage: true});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Paused upload overflows 390px');
  const resumeAt = await page.evaluate(() => calls.length);
  await page.locator('#dataset-upload-start').click();
  await page.waitForFunction(() => calls.some(call => call.operation === 'datasets.upload.commit'));
  assert.equal(await page.evaluate(() => uploads.size), 1);
  assert.equal(await page.evaluate(at => calls.slice(at).find(call => call.operation === 'datasets.upload.chunk').args.offset, resumeAt), 1024 ** 2);
  assert.equal(await page.evaluate(at => calls.slice(at).some(call => call.operation === 'datasets.upload.manifest'), resumeAt), false);
  assert.match(await page.locator('#dataset-upload-status').textContent(), /校验/);
  assert.equal(await page.locator('#dataset-upload-start').isDisabled(), true);
  await page.screenshot({path: join(screenshots, 'upload-publishing-mobile.png'), fullPage: true});
  await page.evaluate(() => {gates.publish = false;});
  await page.waitForFunction(() => document.querySelector('#dataset-catalog').textContent.includes('本机已就绪'));
  assert.equal(await page.locator('[data-use-dataset]').isEnabled(), true);
  const prepare = page.locator('[data-prepare-dataset]');
  assert.ok(!(await prepare.count()) || await prepare.isDisabled(), 'Personal data must not offer public-source prepare');
  assert.equal(await page.evaluate(() => toasts.length), 1);
  const reference = await page.locator('.dataset-card input[readonly]').inputValue();
  assert.match(reference, /^u-0123456789abcdef-browser-data@[a-f0-9]{64}$/);
  await page.screenshot({path: join(screenshots, 'upload-ready-mobile.png'), fullPage: true});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'READY upload overflows 390px');

  // A late old-account begin cannot send data using the new account or refill UI.
  await page.evaluate(() => {gates.begin = true;});
  await page.locator('[name=dataset-name]').fill('late-old-data');
  await page.locator('#dataset-upload-start').click();
  await page.waitForFunction(() => typeof window.releaseBegin === 'function');
  const beforeSwitch = await page.evaluate(() => calls.length);
  await page.evaluate(() => {
    store.authGeneration++; store.principal = {userId: 'new-user', role: 'member'};
    store.listener(); renderDatasets(); releaseBegin();
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => calls.length), beforeSwitch);
  assert.equal(await page.locator('[name=dataset-name]').inputValue(), '');
  assert.equal(await page.evaluate(() => document.querySelector('[name=dataset-directory]').files.length), 0);
  assert.equal(await page.locator('#dataset-upload-progress').isHidden(), true);
  assert.equal(await page.locator('#dataset-upload-start').isEnabled(), true);
  assert.doesNotMatch(await page.locator('#page-datasets').textContent(), /late-old-data|browser-data@/);
  assert.equal(await page.evaluate(() => toasts.length), 1);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('DATASET UPLOAD UI PASS: browser hashes and uploads exact bounded bytes; resource refresh preserves file selection/progress; pause after durable write resumes at confirmed offset; empty files survive; server verification precedes READY; 390px layout; late old-account response cannot send more data or update the new UI; no external requests or browser errors.');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await rm(dataDirectory, {recursive: true, force: true});
}
