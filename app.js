'use strict';

const Homey = require('homey');
const GlueApi = require('./lib/GlueApi');

const POLL_INTERVAL_MS = 60 * 1000;
const VERIFY_DELAY_MS = 20 * 1000;

const ERROR_KEYS = {
  NO_KEY: 'errors.noKey',
  INVALID_KEY: 'errors.invalidKey',
  INVALID_CREDENTIALS: 'errors.invalidCredentials',
  UNEXPECTED_RESPONSE: 'errors.unexpectedResponse',
  TIMEOUT: 'errors.timeout',
  NETWORK: 'errors.network',
};

module.exports = class GlueApp extends Homey.App {

  async onInit() {
    this._migrateLegacyKey();
    this.api = new GlueApi(() => this.homey.settings.get('apiKey'));

    // One request every minute updates all locks.
    this._pollTimer = this.homey.setInterval(() => {
      this.poll().catch(err => this.error('Poll failed:', err.message));
    }, POLL_INTERVAL_MS);

    // Poll right away when the key is saved or changed.
    this.homey.settings.on('set', name => {
      if (name === 'apiKey') this.poll().catch(err => this.error('Poll:', err.message));
    });

    this._lockFailedTrigger = this.homey.flow.getTriggerCard('lock_failed');
    this._disconnectedTrigger = this.homey.flow.getTriggerCard('lock_disconnected');
    // Each flow picks how many minutes a lock must be down; flows without a choice use 10.
    this._disconnectedTrigger.registerRunListener(async (args, state) => (
      Number(args.minutes || 10) === state.minutes
    ));
    this.homey.flow.getActionCard('lock_all').registerRunListener(() => this.lockAll());

    this.homey.setTimeout(() => {
      this.poll().catch(err => this.error('Initial poll:', err.message));
    }, 5000);

    this.log('Glue Lock started');
  }

  /** Turns an API error into an error with a message in the user's language. */
  _localize(err) {
    if (err && err.code === 'HTTP') {
      const status = err.statusCode || '?';
      const key = err.statusCode >= 500 ? 'errors.server' : 'errors.http';
      const text = String(this.homey.__(key, { status })).replace(/\{\{\s*status\s*\}\}/g, status);
      // A server error carries Glue's own explanation, if it sent one, so problems can be traced.
      const detail = err.statusCode >= 500 && err.detail ? ` (Glue: ${err.detail})` : '';
      const localized = new Error(text + detail);
      localized.code = err.code;
      return localized;
    }
    const key = ERROR_KEYS[err && err.code];
    if (!key) return err;
    const localized = new Error(this.homey.__(key));
    localized.code = err.code;
    return localized;
  }

  _devices() {
    return this.homey.drivers.getDriver('glue').getDevices();
  }

  /**
   * This app took over the existing GlueLock app (com.gluelock.lock), which stored the
   * API key under 'GlueLockAuth'. Reuse it so existing users do not have to log in again.
   */
  _migrateLegacyKey() {
    const legacy = this.homey.settings.get('GlueLockAuth');
    if (legacy && !this.homey.settings.get('apiKey')) {
      this.homey.settings.set('apiKey', String(legacy).trim());
      this.log('Migrated API key from the previous GlueLock app');
    }
  }

  hasKey() {
    return Boolean(this.homey.settings.get('apiKey'));
  }

  /**
   * Logs in to Glue with the user's credentials and stores only the API key.
   * The password is used for one request and is never stored or logged.
   */
  async login({ username, password } = {}) {
    let user = String(username || '').trim();
    const pass = String(password || '');
    if (!user || !pass) throw new Error(this.homey.__('errors.missingFields'));
    if (!user.includes('@')) user = user.replace(/[\s-]/g, '');

    let key;
    try {
      key = await this.api.createApiKey(user, pass, 'Homey Glue Lock app');
    } catch (err) {
      this.error('Login failed:', err.code || err.message);
      throw this._localize(err);
    }

    this.homey.settings.set('apiKey', key);
    this.log('Logged in, API key saved');
    return true;
  }

  logout() {
    this.homey.settings.unset('apiKey');
    for (const device of this._devices()) {
      device.setUnavailable(this.homey.__('device.badKey')).catch(this.error);
    }
    return true;
  }

  /** Fetches all locks and pushes the state to the matching devices. */
  async poll() {
    const devices = this._devices();
    if (devices.length === 0) return [];

    let locks;
    try {
      locks = await this.api.getLocks();
    } catch (err) {
      if (err.code === 'INVALID_KEY' || err.code === 'NO_KEY') {
        for (const device of devices) {
          device.setUnavailable(this.homey.__('device.badKey')).catch(this.error);
        }
      }
      throw err;
    }

    for (const device of devices) {
      const lock = locks.find(l => l.id === device.getData().id);
      if (lock) {
        device.applyLock(lock);
      } else {
        device.setUnavailable(this.homey.__('device.gone')).catch(this.error);
      }
    }
    return locks;
  }

  /** Called by a device that has been disconnected/offline for a while. */
  notifyDisconnected(door, status, minutes = 10) {
    this.log(`Lock lost connection: ${door} (${status}) for ${minutes} min`);
    this._disconnectedTrigger.trigger({ door, status }, { minutes }).catch(this.error);
  }

  /** Extra polls shortly after a command, since the lock needs a few seconds. */
  refreshSoon(delays = [4000, 12000]) {
    for (const delay of delays) {
      this.homey.setTimeout(() => {
        this.poll().catch(err => this.error('Poll after command:', err.message));
      }, delay);
    }
  }

  /**
   * Locks every lock. Never unlocks. After VERIFY_DELAY_MS the real state is
   * read back and the 'lock_failed' trigger fires for each lock that is
   * offline, errored or still not locked.
   */
  async lockAll() {
    const devices = this._devices();
    const failed = [];

    await Promise.all(devices.map(async device => {
      const name = device.getName();
      if (!device.getAvailable()) {
        failed.push({ name, reason: this.homey.__('errors.lockOffline') });
        return;
      }
      try {
        await device.sendOperation('lock', { confirm: false });
      } catch (err) {
        failed.push({ name, reason: err.message });
      }
    }));

    this.homey.setTimeout(async () => {
      try {
        await this.poll();
      } catch (err) {
        this.error('Verification failed:', err.message);
      }

      for (const device of devices) {
        const name = device.getName();
        if (failed.some(f => f.name === name)) continue;
        if (!device.getAvailable()) {
          failed.push({ name, reason: this.homey.__('errors.lockOffline') });
        } else if (device.getCapabilityValue('locked') !== true) {
          failed.push({ name, reason: this.homey.__('errors.lockFailed') });
        }
      }

      for (const device of devices) {
        const failure = failed.find(f => f.name === device.getName());
        device.noteResult(!failure, failure && failure.reason);
      }

      for (const f of failed) {
        this.log(`Lock failed: ${f.name} (${f.reason})`);
        this._lockFailedTrigger
          .trigger({ door: f.name, reason: f.reason })
          .catch(this.error);
      }
    }, VERIFY_DELAY_MS);

    return true;
  }

  /** Used by the settings page ("Test connection"). */
  async testConnection() {
    let locks;
    try {
      locks = await this.api.getLocks();
    } catch (err) {
      throw this._localize(err);
    }
    return {
      ok: true,
      count: locks.length,
      locks: locks.map(l => ({ name: l.description, status: l.connectionStatus })),
    };
  }

};
