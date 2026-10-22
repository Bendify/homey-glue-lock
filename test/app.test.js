'use strict';

// Smoke test of the app logic against a fake Homey runtime (no network).
const assert = require('assert');
const Module = require('module');
const path = require('path');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'homey') return path.join(__dirname, 'fake-homey.js');
  return origResolve.call(this, request, ...rest);
};
require.cache[path.join(__dirname, 'fake-homey.js')] = {
  id: 'fake-homey', filename: 'fake-homey.js', loaded: true,
  exports: { App: class {}, Driver: class {}, Device: class {} },
};

const strings = Object.assign({}, require('../locales/en.json'));
const lookup = (key, vars) => {
  let s = key.split('.').reduce((o, k) => (o ? o[k] : undefined), strings) || key;
  Object.entries(vars || {}).forEach(([k, v]) => { s = s.replace(`{{${k}}}`, v); });
  return s;
};

const GlueApp = require('../app');

function makeApp() {
  const store = {};
  const timers = [];
  const triggered = [];
  const app = new GlueApp();
  app.log = () => {};
  app.error = () => {};
  const devices = [];
  app.homey = {
    __: lookup,
    settings: {
      get: k => store[k],
      set: (k, v) => { store[k] = v; },
      unset: k => { delete store[k]; },
      on: () => {},
    },
    drivers: { getDriver: () => ({ getDevices: () => devices }) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    setInterval: () => 0,
    flow: {
      getTriggerCard: () => ({ trigger: async tokens => { triggered.push(tokens); } }),
      getActionCard: () => ({ registerRunListener: () => {} }),
    },
  };
  return { app, store, timers, triggered, devices };
}

function fakeDevice(name, { available = true, locked = false, failOp = false } = {}) {
  const d = {
    name, available, locked, ops: [],
    getName: () => name,
    getAvailable: () => d.available,
    getData: () => ({ id: name }),
    getCapabilityValue: () => d.locked,
    setUnavailable: async () => { d.available = false; },
    applyLock: lock => { d.available = true; d.locked = lock.locked; },
    sendOperation: async type => { if (failOp) throw new Error('The Glue service did not answer in time. Try again.'); d.ops.push(type); d.locked = type === 'lock'; },
    results: [],
    noteResult: (ok, reason) => { d.results.push([ok, reason]); },
  };
  return d;
}

(async () => {
  // login stores only the key
  let { app, store } = makeApp();
  app.api = { createApiKey: async (u, p) => { assert.strictEqual(u, '+46701234567'); assert.strictEqual(p, 'pw'); return 'KEY'; } };
  assert.strictEqual(app.hasKey(), false);
  await app.login({ username: ' +46 70-123 45 67 ', password: 'pw' });
  assert.strictEqual(store.apiKey, 'KEY');
  assert.deepStrictEqual(Object.keys(store), ['apiKey']);
  assert.strictEqual(app.hasKey(), true);

  // email is not mangled
  app.api = { createApiKey: async u => { assert.strictEqual(u, 'a b@x.se'.trim()); return 'K2'; } };
  await app.login({ username: 'a b@x.se', password: 'pw' });

  // missing fields and bad credentials give localized messages
  await assert.rejects(app.login({ username: '', password: '' }), /Enter both username and password/);
  app.api = { createApiKey: async () => { throw Object.assign(new Error('raw'), { code: 'INVALID_CREDENTIALS' }); } };
  await assert.rejects(app.login({ username: 'u', password: 'p' }), /Login failed/);
  assert.strictEqual(store.apiKey, 'K2'); // unchanged after failed login

  // logout removes key
  app.logout();
  assert.strictEqual(app.hasKey(), false);

  // lockAll: ok, offline, error, and one that does not lock
  const ctx = makeApp();
  app = ctx.app;
  const ok = fakeDevice('Ok'); const off = fakeDevice('Off', { available: false });
  const err = fakeDevice('Err', { failOp: true });
  const stuck = fakeDevice('Stuck'); stuck.sendOperation = async () => {}; // accepted but never locks
  ctx.devices.push(ok, off, err, stuck);
  app.poll = async () => [];
  app._lockFailedTrigger = { trigger: async t => { ctx.triggered.push(t); } };
  await app.lockAll();
  assert.deepStrictEqual(ok.ops, ['lock']);
  assert.strictEqual(ctx.timers.length, 1);
  await ctx.timers[0].fn();
  const byDoor = Object.fromEntries(ctx.triggered.map(t => [t.door, t.reason]));
  assert.deepStrictEqual(Object.keys(byDoor).sort(), ['Err', 'Off', 'Stuck']);
  assert.strictEqual(byDoor.Off, 'Offline');
  assert.strictEqual(byDoor.Stuck, 'Did not lock');
  assert.strictEqual(byDoor.Err, 'The Glue service did not answer in time. Try again.');
  assert.deepStrictEqual(ok.results, [[true, undefined]]);
  assert.deepStrictEqual(off.results, [[false, 'Offline']]);
  assert.deepStrictEqual(stuck.results, [[false, 'Did not lock']]);

  // HTTP errors keep the status code; server errors get their own wording
  const e = app._localize(Object.assign(new Error('raw'), { code: 'HTTP', statusCode: 400 }));
  assert.strictEqual(e.message, 'Glue refused the request (status 400).');
  const e5 = app._localize(Object.assign(new Error('raw'), { code: 'HTTP', statusCode: 500 }));
  assert.ok(e5.message.includes('temporary server error (status 500)'), e5.message);
  const e5d = app._localize(Object.assign(new Error('raw'), { code: 'HTTP', statusCode: 500, detail: 'lock busy' }));
  assert.ok(e5d.message.endsWith('(Glue: lock busy)'), e5d.message);

  console.log('APP SMOKE TEST OK');
})().catch(e => { console.error(e); process.exit(1); });
