// Test-only exception for the single legacy training-capability probe.
// A native 400 message is deferred until its actual request/reply is verified.
import assert from 'node:assert/strict';

export function collectTrainingCapabilityConsole(page, origin, unexpected) {
  const api = origin + '/api/call', requests = [], metadata = new WeakMap();
  const failures = [], candidates = [], pending = [];
  let session = 0;
  page.on('framenavigated', frame => {if (frame === page.mainFrame()) session++;});
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url() === origin + '/api/login') {session++;return;}
    if (request.url() !== api) return;
    let operation;
    try {operation = request.postDataJSON()?.operation;} catch {}
    const entry = {session, operation};
    metadata.set(request, entry);requests.push(entry);
  });
  page.on('response', response => {
    if (response.url() !== api || response.status() !== 400) return;
    const entry = {...metadata.get(response.request()), unknown: false};
    failures.push(entry);
    pending.push(response.json().then(body => {
      entry.unknown = entry.operation === 'datasets.training.capabilities' && body?.error === '未知执行操作。';
    }, () => {}));
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (message.location().url === api && message.text() === 'Failed to load resource: the server responded with a status of 400 (Bad Request)') candidates.push({session, text: message.text()});
    else unexpected(message.text());
  });
  return async () => {
    await Promise.all(pending);
    const legacySessions = new Set(failures.filter(entry => entry.unknown).map(entry => entry.session));
    for (const loginSession of legacySessions) {
      assert.equal(requests.filter(entry => entry.session === loginSession && entry.operation === 'datasets.training.capabilities').length, 1, 'An unsupported training capability is requested at most once per login session');
      assert.equal(failures.filter(entry => entry.session === loginSession && entry.unknown).length, 1, 'An unsupported training capability returns at most one 400 per login session');
    }
    for (const loginSession of new Set(candidates.map(entry => entry.session))) {
      const messages = candidates.filter(entry => entry.session === loginSession);
      const replies = failures.filter(entry => entry.session === loginSession);
      // Also inspect other /api/call 400s: otherwise their identical native
      // message could be mistaken for the permitted capability response.
      if (replies.length === 1 && replies[0].unknown && messages.length <= 1) continue;
      for (const message of messages) unexpected(message.text);
    }
  };
}
