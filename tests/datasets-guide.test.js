import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createServer} from '../server.mjs';
import {createPortalServer} from '../portal-server.mjs';

async function port() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve);});
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve)); return value;
}

async function check(origin) {
  const response = await fetch(origin + '/guide/datasets');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain; charset=utf-8$/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const content = await response.text();
  assert.match(content, /固定版本数据集/); assert.match(content, /gpuctl data prepare/);
  assert.match(content, /owners/); assert.match(content, /READY/);
  assert.equal((await fetch(origin + '/guide/datasets', {method: 'HEAD'})).status, 200);
  assert.equal(await (await fetch(origin + '/guide/datasets', {method: 'HEAD'})).text(), '');
  assert.equal((await fetch(origin + '/guide/datasets', {method: 'POST'})).status, 405);
  for (const path of ['/guide/unknown', '/docs/DATASETS.md', '/guide/node-config.json'])
    assert.equal((await fetch(origin + path)).status, 404);
  const userGuide = await (await fetch(origin + '/guide/user')).text();
  assert.ok(userGuide.includes(origin + '/guide/datasets'));
  assert.ok(!userGuide.includes('https://gpu.example.com/guide/datasets'));
  assert.match(await (await fetch(origin)).text(), /href="\/guide\/datasets"[^>]+>数据集手册/);
  const project = await fetch(origin + '/guide/projects');
  assert.equal(project.status, 200);
  assert.match(project.headers.get('content-type'), /^text\/plain; charset=utf-8$/);
  assert.match(await project.text(), /gpuctl project publish/);
  assert.equal(await (await fetch(origin + '/guide/projects', {method:'HEAD'})).text(), '');
  assert.equal((await fetch(origin + '/guide/projects', {method:'POST'})).status, 405);
  assert.ok(userGuide.includes(origin + '/guide/projects'));
  assert.match(await (await fetch(origin)).text(), /href="\/guide\/projects"[^>]+>项目手册/);
  for (const [route, title] of [['terminal-sessions', /终端/], ['diagnostics', /作业诊断包/], ['ray-resources', /默认.*common-p0/]]) {
    const guide = await fetch(origin + '/guide/' + route);
    assert.equal(guide.status, 200);
    assert.match(guide.headers.get('content-type'), /^text\/plain; charset=utf-8$/);
    assert.match(await guide.text(), title);
    assert.equal(await (await fetch(origin + '/guide/' + route, {method: 'HEAD'})).text(), '');
    assert.equal((await fetch(origin + '/guide/' + route, {method: 'POST'})).status, 405);
    assert.ok(userGuide.includes(origin + '/guide/' + route));
  }
}

test('production dataset guide is generic plaintext with existing public manual boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gpuq-guide-'));
  const bootstrap = join(directory, 'bootstrap.json'); let server;
  try {
    await writeFile(bootstrap, JSON.stringify({username: 'admin', password: 'Local-Guide-Test-Only-Password-2026!'}), {mode: 0o600});
    const number = await port(), origin = `http://127.0.0.1:${number}`;
    ({server} = await createPortalServer({database: join(directory, 'portal.sqlite'), bootstrap, origin, secure: false}));
    await new Promise(resolve => server.listen(number, '127.0.0.1', resolve));
    await check(origin);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});

test('local demo serves the same dataset manual and preserves its UI module', async () => {
  const server = await createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await check(origin);
    assert.equal((await fetch(origin + '/datasets-ui.js')).status, 200);
  } finally {await new Promise(resolve => server.close(resolve));}
});

test('manual online references remain generic rather than exposing deployment data', async () => {
  for (const name of ['USER_README.md', 'ADMIN_README.md']) {
    const text = await readFile(new URL('../' + name, import.meta.url), 'utf8');
    assert.ok(text.includes('https://gpu.example.com/guide/datasets'));
  }
  const context = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
  for (const manual of ['DATASETS.md', 'PROJECTS.md', 'TERMINAL_SESSIONS.md', 'JOB_DIAGNOSTICS.md', 'RAY_RESOURCES.md'])
    assert.ok(context.split(/\r?\n/).includes('!docs/' + manual), 'production manual must enter the Docker build context');
  const docker = await readFile(new URL('../deploy/Dockerfile', import.meta.url), 'utf8');
  for (const manual of ['TERMINAL_SESSIONS.md', 'JOB_DIAGNOSTICS.md', 'RAY_RESOURCES.md'])
    assert.ok(docker.includes('docs/' + manual), 'new guides must be copied into the production image');
});
