'use strict';

const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');

const { lockedFromEvent } = require('../lib/lockState');

assert.strictEqual(lockedFromEvent('localUnlock'), false);
assert.strictEqual(lockedFromEvent('remoteUnlock'), false);
assert.strictEqual(lockedFromEvent('remoteLock'), true);
assert.strictEqual(lockedFromEvent('localLock'), true);
assert.strictEqual(lockedFromEvent('pressAndGo'), true);
assert.strictEqual(lockedFromEvent('somethingElse'), null);
assert.strictEqual(lockedFromEvent(undefined), null);

// Stub https.request so no real network is used.
const calls = [];
let responder = null;
https.request = (opts, cb) => {
  const req = new EventEmitter();
  let body = '';
  req.write = c => { body += c; };
  req.destroy = e => req.emit('error', e);
  req.end = () => {
    calls.push({ opts, body });
    const { status, payload } = responder(opts, body);
    const res = new EventEmitter();
    res.setEncoding = () => {};
    res.statusCode = status;
    cb(res);
    setImmediate(() => {
      if (payload !== undefined) res.emit('data', typeof payload === 'string' ? payload : JSON.stringify(payload));
      res.emit('end');
    });
  };
  return req;
};

const GlueApi = require('../lib/GlueApi');
const KEY = 'k'.repeat(108);

(async () => {
  // extractKey
  assert.strictEqual(GlueApi.extractKey({ apiKey: KEY }), KEY);
  assert.strictEqual(GlueApi.extractKey({ id: 'abc', secretThing: { deep: KEY } }), KEY);
  assert.strictEqual(GlueApi.extractKey(KEY), KEY);
  assert.strictEqual(GlueApi.extractKey({ id: 'short' }), null);
  assert.strictEqual(GlueApi.extractKey(null), null);

  // locks + operations
  responder = (opts, body) => {
    if (opts.headers.Authorization !== 'Api-Key good') return { status: 401, payload: '' };
    return opts.method === 'POST' ? { status: 202, payload: undefined } : { status: 200, payload: [{ id: 'a', description: 'X' }] };
  };
  assert.deepStrictEqual(await new GlueApi(() => 'good').getLocks(), [{ id: 'a', description: 'X' }]);
  assert.strictEqual(await new GlueApi(() => 'good').operate('a', 'lock'), null);
  const op = calls[calls.length - 1];
  assert.strictEqual(op.opts.path, '/v1/locks/a/operations');
  assert.strictEqual(op.body, '{"type":"lock"}');
  await assert.rejects(new GlueApi(() => 'bad').getLocks(), e => e.code === 'INVALID_KEY');
  await assert.rejects(new GlueApi(() => '').getLocks(), e => e.code === 'NO_KEY');
  await assert.rejects(new GlueApi(() => 'good').operate('a', 'open'), e => e.code === 'BAD_ACTION');

  // operate retries temporary server errors, but not client errors
  let posts = 0;
  responder = () => { posts++; return posts < 3 ? { status: 500, payload: 'boom' } : { status: 202, payload: undefined }; };
  const seen = [];
  const retrying = new GlueApi(() => 'good', { retryDelays: [1, 1] });
  assert.strictEqual(await retrying.operate('a', 'lock', { onRetry: n => seen.push(n) }), null);
  assert.strictEqual(posts, 3);
  assert.deepStrictEqual(seen, [1, 2]);

  posts = 0;
  responder = () => { posts++; return { status: 500, payload: 'boom' }; };
  await assert.rejects(retrying.operate('a', 'lock'), e => e.code === 'HTTP' && e.statusCode === 500);
  assert.strictEqual(posts, 3); // first try + two retries

  posts = 0;
  responder = () => { posts++; return { status: 400, payload: 'bad' }; };
  await assert.rejects(retrying.operate('a', 'lock'), e => e.code === 'HTTP' && e.statusCode === 400);
  assert.strictEqual(posts, 1);

  responder = () => ({ status: 401, payload: '' });
  await assert.rejects(retrying.operate('a', 'lock'), e => e.code === 'INVALID_KEY');

  // createApiKey: success, sends Basic auth and scopes
  responder = () => ({ status: 200, payload: { id: 'x', apiKey: KEY } });
  const api = new GlueApi(() => null);
  assert.strictEqual(await api.createApiKey('+46701234567', 'p@ss:word', 'Homey'), KEY);
  const c = calls[calls.length - 1];
  assert.strictEqual(c.opts.path, '/v1/api-keys');
  assert.strictEqual(c.opts.method, 'POST');
  assert.strictEqual(c.opts.headers.Authorization, 'Basic ' + Buffer.from('+46701234567:p@ss:word').toString('base64'));
  assert.deepStrictEqual(JSON.parse(c.body), { name: 'Homey', scopes: ['events.read', 'locks.read', 'locks.write'] });

  // createApiKey: bad login, odd response
  responder = () => ({ status: 401, payload: '' });
  await assert.rejects(api.createApiKey('a', 'b', 'n'), e => e.code === 'INVALID_CREDENTIALS');
  responder = () => ({ status: 200, payload: { id: 'x' } });
  await assert.rejects(api.createApiKey('a', 'b', 'n'), e => e.code === 'UNEXPECTED_RESPONSE');
  responder = () => ({ status: 500, payload: 'boom' });
  await assert.rejects(api.createApiKey('a', 'b', 'n'), e => e.code === 'HTTP');

  // the password must never be sent anywhere except the Basic header
  responder = () => ({ status: 200, payload: { apiKey: KEY } });
  await api.createApiKey('user', 'hemligt-lösen', 'n');
  const last = calls[calls.length - 1];
  assert.ok(!last.body.includes('hemligt'));
  assert.ok(!last.opts.path.includes('hemligt'));

  console.log('ALL TESTS OK');
})().catch(e => { console.error(e); process.exit(1); });
