import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {collectTrainingCapabilityConsole} from './training-capability-console.mjs';

const origin = 'http://fixture.invalid', api = origin + '/api/call';
const native400 = 'Failed to load resource: the server responded with a status of 400 (Bad Request)';
function fixture() {
  const page = new EventEmitter(), errors = [], frame = {};
  page.mainFrame = () => frame;
  const verify = collectTrainingCapabilityConsole(page, origin, text => errors.push(text));
  const consoleError = (text = native400, url = api) => page.emit('console', {type: () => 'error', text: () => text, location: () => ({url})});
  function request(operation = 'datasets.training.capabilities', url = api, method = 'POST', navigation = false, sourceFrame = frame) {
    const value = {url: () => url, method: () => method, postDataJSON: () => ({operation}), isNavigationRequest: () => navigation, frame: () => sourceFrame};page.emit('request', value);return value;
  }
  function reply(value = request(), status = 400, body = {error: '未知执行操作。'}, read = async () => body) {
    page.emit('response', {request: () => value, url: value.url, status: () => status, json: read});
  }
  return {page, frame, errors, verify, request, reply, consoleError};
}
test('only an actual unknown-capability 400 can explain one native console error, in either event order', async () => {
  for (const consoleFirst of [false, true]) {
    const f = fixture(), request = f.request();
    if (consoleFirst) f.consoleError();f.reply(request);if (!consoleFirst) f.consoleError();
    await f.verify();assert.deepEqual(f.errors, []);
  }
});
test('an unknown-capability reply without a console message is still counted', async () => {
  const f = fixture();f.reply();await f.verify();assert.deepEqual(f.errors, []);
});
test('ordinary errors, other operations, URLs, methods, statuses and unreadable bodies cannot be filtered', async () => {
  const cases = [
    f => f.reply(f.request('datasets.list')),
    f => f.reply(f.request(), 400, {error: '参数无效。'}),
    f => f.reply(f.request(), 403),
    f => f.reply(f.request(), 404),
    f => f.reply(f.request(), 503),
    f => f.reply(f.request(), 200, {result: {protocol: 1}}),
    f => f.reply(f.request(undefined, origin + '/other')),
    f => f.reply(f.request(undefined, api, 'GET')),
    f => f.reply(f.request(), 400, null, async () => {throw Error('invalid JSON');}),
    () => {},
  ];
  for (const emit of cases) {const f = fixture();emit(f);f.consoleError();await f.verify();assert.deepEqual(f.errors, [native400]);}
});
test('unrelated console errors stay visible even beside a valid legacy reply', async () => {
  const f = fixture();f.reply();f.consoleError();f.consoleError('script failure', origin + '/app.js');f.consoleError(native400, origin + '/unrelated.js');
  await f.verify();assert.deepEqual(f.errors, ['script failure', native400]);
});
test('a different API 400 cannot borrow the capability exception even if it has no separate console message', async () => {
  const f = fixture();f.reply();f.reply(f.request('jobs.submit'));f.consoleError();await f.verify();assert.deepEqual(f.errors, [native400]);
});
test('a duplicate probe, duplicate reply or duplicate native message fails', async () => {
  const f = fixture();f.reply();f.reply();f.consoleError();await assert.rejects(f.verify(), /at most once/);
  const g = fixture(), request = g.request();g.reply(request);g.reply(request);await assert.rejects(g.verify(), /at most one 400/);
  const h = fixture();h.reply();h.consoleError();h.consoleError();await h.verify();assert.deepEqual(h.errors, [native400, native400]);
});
test('login and page refresh reset the count, but an old account reply cannot explain a new account message', async () => {
  for (const refresh of [false, true]) {
    const f = fixture();f.reply();f.consoleError();
    if (refresh) f.request(undefined, origin, 'GET', true);else f.request(undefined, origin + '/api/login');
    f.reply();f.consoleError();await f.verify();assert.deepEqual(f.errors, []);
  }
  const f = fixture(), old = f.request();f.request(undefined, origin + '/api/login');f.reply(old);f.consoleError();await f.verify();assert.deepEqual(f.errors, [native400]);
});
test('room hash changes and iframe navigation do not reset the once-per-session allowance', async () => {
  for (const iframe of [false, true]) {
    const f = fixture();f.reply();f.consoleError();
    if (iframe) f.request(undefined, origin + '/child', 'GET', true, {});else f.page.emit('framenavigated', f.frame);
    f.reply();f.consoleError();await assert.rejects(f.verify(), /at most once/);
  }
});
test('verification awaits the network body before allowing a native message', async () => {
  const f = fixture();let release, done = false;
  f.reply(f.request(), 400, null, () => new Promise(resolve => {release = resolve;}));f.consoleError();
  const verified = f.verify().then(() => {done = true;});await Promise.resolve();assert.equal(done, false);
  release({error: '未知执行操作。'});await verified;assert.deepEqual(f.errors, []);
});
