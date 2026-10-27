'use strict';

const Homey = require('homey');

module.exports = class GlueLockDriver extends Homey.Driver {

  async onPair(session) {
    session.setHandler('hasKey', async () => this.homey.app.hasKey());

    session.setHandler('login', async data => {
      await this.homey.app.login(data || {});
      return true;
    });

    session.setHandler('list_devices', async () => this.onPairListDevices());
  }

  async onPairListDevices() {
    let locks;
    try {
      locks = await this.homey.app.api.getLocks();
    } catch (err) {
      throw this.homey.app._localize(err);
    }

    return locks.map(lock => ({
      name: lock.description || lock.serialNumber,
      data: { id: lock.id },
      store: {
        serialNumber: lock.serialNumber,
        firmwareVersion: lock.firmwareVersion,
      },
    }));
  }

};
