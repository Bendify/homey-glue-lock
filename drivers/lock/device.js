'use strict';

const Homey = require('homey');
const { lockedFromEvent } = require('../../lib/lockState');

const CONFIRM_TIMEOUT_MS = 20 * 1000;
const POLL_EVERY_MS = 2 * 1000;
const ASSUME_AFTER_MS = 6 * 1000;
const WARNING_TTL_MS = 10 * 60 * 1000;
// Polls (one per minute) in a row a lock must be disconnected/offline before the flow trigger fires.
const DISCONNECT_POLLS = 2;

// Glue reports 'connected', 'disconnected' and 'offline'. Only 'offline' is treated as
// unreachable. For 'disconnected' the command is still attempted and its result confirmed.
const isOffline = lock => String(lock.connectionStatus).toLowerCase() === 'offline';

module.exports = class GlueLockDevice extends Homey.Device {

  async onInit() {
    for (const capability of ['last_event', 'command_status']) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }

    // Overridable for tests.
    this._confirmTimeoutMs = CONFIRM_TIMEOUT_MS;
    this._pollEveryMs = POLL_EVERY_MS;
    this._assumeAfterMs = ASSUME_AFTER_MS;
    this._lastEventTime = null;

    // The returned promise stays pending until the lock has confirmed (or failed),
    // so the app shows the button as busy while the command is on its way.
    this.registerCapabilityListener('locked', value => this.sendOperation(value ? 'lock' : 'unlock'));

    this.homey.setTimeout(() => {
      this.homey.app.poll().catch(err => this.error('Initial poll:', err.message));
    }, 2000);
  }

  /** Translates and fills in {{tags}} ourselves, so it works even if the runtime leaves them. */
  _t(key, tags = {}) {
    const text = String(this.homey.__(key, tags));
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in tags ? tags[k] : m));
  }

  _time() {
    try {
      return new Date().toLocaleTimeString(this.homey.i18n.getLanguage(), {
        timeZone: this.homey.clock.getTimezone(),
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (err) {
      return '';
    }
  }

  _sleep(ms) {
    return new Promise(resolve => this.homey.setTimeout(resolve, ms));
  }

  _setStatus(text) {
    return this.setCapabilityValue('command_status', text).catch(this.error);
  }

  _fail(reason) {
    const text = this._t('device.status.failed', { time: this._time(), reason });
    this._setStatus(text);
    this.setWarning(text).catch(this.error);
    if (this._warnTimer) this.homey.clearTimeout(this._warnTimer);
    this._warnTimer = this.homey.setTimeout(() => {
      this.unsetWarning().catch(this.error);
    }, WARNING_TTL_MS);
  }

  _succeed(locked) {
    if (this._warnTimer) this.homey.clearTimeout(this._warnTimer);
    if (this._connection === 'disconnected') {
      this.setWarning(this._t('device.disconnected')).catch(this.error);
    } else {
      this.unsetWarning().catch(this.error);
    }
    const key = locked ? 'device.status.locked' : 'device.status.unlocked';
    this._setStatus(this._t(key, { time: this._time() }));
  }

  /** Lets 'Lock all doors' report the final result per lock. */
  noteResult(ok, reason) {
    if (ok) {
      this._succeed(this.getCapabilityValue('locked') === true);
    } else {
      this._fail(reason);
    }
  }

  /**
   * Sends lock/unlock to Glue.
   * With confirm (default) it waits until the lock reports the new state and
   * throws a clear error if Glue refuses, the lock is offline or it times out.
   */
  async sendOperation(type, { confirm = true } = {}) {
    const target = type === 'lock';
    const before = this._lastEventTime;

    await this._setStatus(this.homey.__('device.status.contacting'));
    try {
      await this.homey.app.api.operate(this.getData().id, type, {
        onRetry: () => this._setStatus(this._t('device.status.retrying')),
      });
    } catch (err) {
      const hubDown = err.code === 'HTTP' && err.statusCode >= 500
        && this._connection && this._connection !== 'connected';
      const localized = hubDown
        ? new Error(this._t('errors.hubUnreachable'))
        : this.homey.app._localize(err);
      this.error(`Command ${type} failed:`, err.code, err.statusCode || '', err.detail || err.message);
      this._fail(localized.message);
      throw localized;
    }
    await this._setStatus(this.homey.__('device.status.sent'));

    if (!confirm) {
      await this.setCapabilityValue('locked', target).catch(this.error);
      this.homey.app.refreshSoon();
      return;
    }

    const result = await this._waitForLock(target, before);
    if (result === 'ok') {
      await this.setCapabilityValue('locked', target).catch(this.error);
      this._succeed(target);
      this.homey.app.refreshSoon([8000]);
      return;
    }

    const message = this.homey.__(result === 'offline' ? 'errors.lockUnreachable' : 'errors.notConfirmed');
    this._fail(message);
    this.homey.app.refreshSoon();
    throw new Error(message);
  }

  /** @returns {Promise<'ok'|'offline'|'timeout'>} */
  async _waitForLock(target, before) {
    const started = Date.now();
    while (Date.now() - started < this._confirmTimeoutMs) {
      await this._sleep(this._pollEveryMs);

      let locks;
      try {
        locks = await this.homey.app.api.getLocks();
      } catch (err) {
        continue; // temporary problem, keep trying until the timeout
      }

      const lock = locks.find(l => l.id === this.getData().id);
      if (!lock) continue;
      if (isOffline(lock)) return 'offline';

      const event = lock.lastLockEvent;
      if (event && lockedFromEvent(event.eventType) === target) {
        const isNewEvent = event.eventTime !== before;
        if (isNewEvent || Date.now() - started >= this._assumeAfterMs) {
          this.applyLock(lock);
          return 'ok';
        }
      }
    }
    return 'timeout';
  }

  /** Updates the device from a lock object returned by GET /v1/locks. */
  applyLock(lock) {
    const previous = this._connection;
    this._connection = String(lock.connectionStatus).toLowerCase();

    // Fire 'A lock lost its connection' once per outage, after a couple of polls in a row.
    if (this._connection === 'disconnected' || this._connection === 'offline') {
      this._downPolls = (this._downPolls || 0) + 1;
      if (this._downPolls === DISCONNECT_POLLS) {
        this.homey.app.notifyDisconnected(this.getName(), this._connection);
      }
    } else if (this._connection === 'connected') {
      this._downPolls = 0;
    }

    if (isOffline(lock)) {
      if (this.getAvailable()) {
        this.setUnavailable(this.homey.__('device.offline')).catch(this.error);
      }
      return;
    }

    if (!this.getAvailable()) {
      this.setAvailable().catch(this.error);
    }

    // 'disconnected' usually means the Glue hub has lost its connection (wifi). Commands
    // can still be tried, but the lock may not be reachable, so say so.
    if (this._connection === 'disconnected' && previous !== 'disconnected') {
      this.setWarning(this._t('device.disconnected')).catch(this.error);
    } else if (this._connection === 'connected' && previous === 'disconnected') {
      this.unsetWarning().catch(this.error);
    }

    if (typeof lock.batteryStatus === 'number') {
      this.setCapabilityValue('measure_battery', lock.batteryStatus).catch(this.error);
    }

    const event = lock.lastLockEvent;
    if (event && event.eventType) {
      this._lastEventTime = event.eventTime;
      const locked = lockedFromEvent(event.eventType);
      if (locked !== null) {
        this.setCapabilityValue('locked', locked).catch(this.error);
      }
      this.setCapabilityValue('last_event', this._describe(event)).catch(this.error);
    }
  }

  _describe(event) {
    const key = `events.${event.eventType}`;
    let label = this.homey.__(key);
    if (!label || label === key) {
      // Unknown event type: show it as readable words, e.g. "keypadUnlock" -> "Keypad unlock".
      const words = String(event.eventType).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      label = words.charAt(0).toUpperCase() + words.slice(1);
    }

    let when = '';
    try {
      when = new Date(event.eventTime).toLocaleString(this.homey.i18n.getLanguage(), {
        timeZone: this.homey.clock.getTimezone(),
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (err) {
      when = String(event.eventTime || '');
    }
    return `${label} ${when}`.trim();
  }

};
