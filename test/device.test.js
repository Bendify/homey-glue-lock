'use strict';

// Tests the lock/unlock flow of the device (status text, confirmation, errors)
// against a fake Homey runtime. No network.
const assert = require('assert');
const Module = require('module');
const path = require('path');

class FakeDevice {
  constructor() { this._caps = {}; this._available = true; this._warning = null; this.statuses = []; }
  hasCapability(c) { return c in this._caps; }
  async addCapability(c) { this._caps[c] = null; }
  async setCapabilityValue(c, v) { this._caps[c] = v; if (c === 'command_status') this.statuses.push(v); }
  getCapabilityValue(c) { return this._caps[c]; }
  registerCapabilityListener(c, fn) { this._listener = fn; }
  getData() { return { id: 'L1' }; }
  getName() { return 'Ytterdörr'; }
  getAvailable() { return this._available; }
  async setAvailable() { this._available = true; }
  async setUnavailable() { this._available = false; }
  async setWarning(m) { this._warning = m; }
  async unsetWarning() { this._warning = null; }
  error() {}
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'homey') return path.join(__dirname, 'fake-homey-device.js');
  return origResolve.call(this, request, ...rest);
};
require.cache[path.join(__dirname, 'fake-homey-device.js')] = {
  id: 'fake', filename: 'fake-homey-device.js', loaded: true,
  exports: { Device: FakeDevice },
};

const strings = require('../locales/en.json');
const t = (key, vars) => {
  let s = key.split('.').reduce((o, k) => (o ? o[k] : undefined), strings) || key;
  Object.entries(vars || {}).forEach(([k, v]) => { s = s.replace(`{{${k}}}`, v); });
  return s;
};

const GlueLockDevice = require('../drivers/glue/device');

const notified = [];

async function makeDevice({ operate, getLocks }) {
  const device = new GlueLockDevice();
  device.homey = {
    __: t,
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); if (ms >= 1000) id.unref(); return id; },
    clearTimeout: id => clearTimeout(id),
    clock: { getTimezone: () => 'Europe/Stockholm' },
    i18n: { getLanguage: () => 'en' },
    app: {
      api: { operate, getLocks },
      _localize: err => (err.code === 'NETWORK' ? new Error(t('errors.network')) : err),
      refreshSoon: () => {},
      notifyDisconnected: (door, status, minutes) => notified.push(minutes === undefined ? [door, status] : [door, status, minutes]),
      poll: async () => {},
    },
  };
  await device.onInit();
  device._confirmTimeoutMs = 120;
  device._pollEveryMs = 10;
  device._assumeAfterMs = 40;
  device._available = true;
  return device;
}

const lockObj = (eventType, eventTime, connectionStatus = 'connected') => ({
  id: 'L1', connectionStatus, batteryStatus: 80, lastLockEvent: { eventType, eventTime },
});

(async () => {
  // 1) success: new event arrives after a few polls
  let polls = 0;
  let d = await makeDevice({
    operate: async () => null,
    getLocks: async () => [++polls < 3 ? lockObj('localUnlock', 't1') : lockObj('remoteLock', 't2')],
  });
  d._lastEventTime = 't1';
  await d._listener(true);
  assert.strictEqual(d.getCapabilityValue('locked'), true);
  assert.strictEqual(d._warning, null);
  assert.ok(/^Contacting/.test(d.statuses[0]));
  assert.ok(/^Command accepted/.test(d.statuses[1]));
  assert.ok(/^Locked /.test(d.statuses[d.statuses.length - 1]));

  // 2) the command goes out but the lock is offline
  d = await makeDevice({ operate: async () => null, getLocks: async () => [lockObj('localUnlock', 't1', 'offline')] });
  await assert.rejects(d._listener(true), /The lock is offline/);
  assert.ok(/^Failed /.test(d.statuses[d.statuses.length - 1]));
  assert.ok(d._warning && d._warning.includes('offline'));

  // 3) accepted by Glue but never confirmed
  d = await makeDevice({ operate: async () => null, getLocks: async () => [lockObj('localUnlock', 't1')] });
  d._lastEventTime = 't1';
  await assert.rejects(d._listener(true), /did not confirm within 20 seconds/);
  assert.ok(d._warning);

  // 4) cloud unreachable: clear message, nothing is waited for
  d = await makeDevice({ operate: async () => { throw Object.assign(new Error('raw'), { code: 'NETWORK' }); }, getLocks: async () => [] });
  await assert.rejects(d._listener(false), /Could not reach the Glue service/);
  assert.ok(/Could not reach/.test(d._warning));

  // 5) already in the wanted state and no new event: accepted after the grace period
  d = await makeDevice({ operate: async () => null, getLocks: async () => [lockObj('remoteLock', 't1')] });
  d._lastEventTime = 't1';
  await d._listener(true);
  assert.strictEqual(d.getCapabilityValue('locked'), true);

  // 6) a later success clears an earlier warning
  let n = 0;
  d = await makeDevice({ operate: async () => null, getLocks: async () => [n++ < 100 ? lockObj('localLock', 't9') : null] });
  d._warning = 'old warning';
  d._lastEventTime = 't1';
  await d._listener(true);
  assert.strictEqual(d._warning, null);

  // 7) confirm:false (used by Lock all) returns right after Glue accepted
  d = await makeDevice({ operate: async () => null, getLocks: async () => { throw new Error('should not poll'); } });
  await d.sendOperation('lock', { confirm: false });
  assert.strictEqual(d.getCapabilityValue('locked'), true);

  // 8) 'disconnected' (seen on real locks) is not offline: stays available and can be locked
  d = await makeDevice({ operate: async () => null, getLocks: async () => [lockObj('remoteLock', 't2', 'disconnected')] });
  d._lastEventTime = 't1';
  d.applyLock(lockObj('localUnlock', 't1', 'disconnected'));
  assert.strictEqual(d.getAvailable(), true);
  assert.strictEqual(d.getCapabilityValue('locked'), false);
  await d._listener(true);
  assert.strictEqual(d.getCapabilityValue('locked'), true);

  // 9) only 'offline' makes the lock unavailable
  d = await makeDevice({ operate: async () => null, getLocks: async () => [] });
  d.applyLock(lockObj('localUnlock', 't1', 'offline'));
  assert.strictEqual(d.getAvailable(), false);
  d.applyLock(lockObj('localUnlock', 't1', 'connected'));
  assert.strictEqual(d.getAvailable(), true);

  // 10) 'disconnected' (hub lost wifi) warns, and a 500 from Glue is explained as a hub problem
  const http500 = () => { throw Object.assign(new Error('raw'), { code: 'HTTP', statusCode: 500 }); };
  d = await makeDevice({ operate: async () => http500(), getLocks: async () => [] });
  d.applyLock(lockObj('localUnlock', 't1', 'disconnected'));
  await new Promise(r => setImmediate(r));
  assert.ok(/cannot reach the hub/i.test(d._warning), d._warning);
  assert.strictEqual(d.getAvailable(), true);
  await assert.rejects(d._listener(true), /Glue cloud cannot reach the hub/);
  assert.ok(/restarting the hub/.test(d._warning));
  d.applyLock(lockObj('localUnlock', 't1', 'connected'));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(d._warning, null);

  // 11) a 500 while the lock is 'connected' is still reported as a server error
  d = await makeDevice({ operate: async () => http500(), getLocks: async () => [] });
  d.applyLock(lockObj('localUnlock', 't1', 'connected'));
  await assert.rejects(d._listener(true), e => e.code === 'HTTP');

  // 12) 'A lock lost its connection' fires once per chosen delay and re-arms on reconnect
  notified.length = 0;
  d = await makeDevice({ operate: async () => null, getLocks: async () => [] });
  let clock = 1000000;
  d._now = () => clock;
  const min = n => { clock += n * 60000; };
  d.applyLock(lockObj('localUnlock', 't1', 'disconnected'));
  min(1); d.applyLock(lockObj('localUnlock', 't1', 'disconnected'));
  assert.deepStrictEqual(notified, []);
  min(1); d.applyLock(lockObj('localUnlock', 't1', 'disconnected'));
  assert.deepStrictEqual(notified, [['Ytterdörr', 'disconnected', 2]]);
  min(0.2); d.applyLock(lockObj('localUnlock', 't1', 'disconnected')); // extra poll: no repeat
  assert.strictEqual(notified.length, 1);
  min(3); d.applyLock(lockObj('localUnlock', 't1', 'disconnected'));
  assert.deepStrictEqual(notified[1], ['Ytterdörr', 'disconnected', 5]);
  min(5); d.applyLock(lockObj('localUnlock', 't1', 'disconnected'));
  assert.deepStrictEqual(notified[2], ['Ytterdörr', 'disconnected', 10]);
  d.applyLock(lockObj('localUnlock', 't1', 'connected'));
  d.applyLock(lockObj('localUnlock', 't1', 'disconnected'));
  min(1); d.applyLock(lockObj('localUnlock', 't1', 'disconnected'));
  assert.strictEqual(notified.length, 3); // new outage starts counting from zero

  console.log('DEVICE TEST OK');
})().catch(e => { console.error(e); process.exit(1); });
