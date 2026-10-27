import Homey from 'homey';
import axios from 'axios';
import _ from 'underscore';

class GlueDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('GlueDevice has been initialized');

    // Arrange
    var self = this;
    var deviceData = this.getData();
    var lockId = deviceData.id;
    var glueLockAuth = this.homey.settings.get("GlueLockAuth");


    // Register listeners:
    this.registerCapabilityListener("locked", async (actionLock) => {
      // Send action to device
      this.sendActionToDevice(lockId, glueLockAuth, actionLock);
    });


    // Pull battery status 
    setInterval(() => {
      this.loadCurrentLockState(lockId, glueLockAuth);
    }, 4 * 60 * 60 * 1000 /* pull every hour */);

    // Get latest state:
    this.loadCurrentLockState(lockId, glueLockAuth);

  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('GlueDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log("GlueDevice settings where changed");
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('GlueDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('GlueDevice has been deleted');
  }

  public loadCurrentLockState = (lockId: string, glueLockAuth: string) => {
    // Arrange
    var options = {
      method: 'get',
      headers: {
        'Authorization': `Api-Key ${glueLockAuth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    // Act
    axios.get(`https://user-api.gluehome.com/v1/locks/${lockId}`, options)
      .then((response) => {
        var lockJson = response.data;
        var deviceIsLockedFromLastState = !(lockJson.lastLockEvent.eventType + "").toLowerCase().includes("unlock");

        this.log("Lock state", lockJson.batteryStatus, lockJson.connectionStatus, lockJson.lastLockEvent, deviceIsLockedFromLastState);


        this.setCapabilityValue("measure_battery", lockJson.batteryStatus);
        this.setCapabilityValue("locked", deviceIsLockedFromLastState);

      })
      .catch((error) => {
        console.log("ERROR", error);
      })
      .finally(() => {
        // always executed
      });
  }

  public sendActionToDevice = (lockId: string, glueLockAuth: string, lock: boolean) => {
    // Arrange
    var options = {
      method: 'post',
      headers: {
        'Authorization': `Api-Key ${glueLockAuth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    var body = {
      "type": lock ? "lock" : "unlock"
    };

    console.log("Action taken", "LOCK", lock);

    // Act
    axios.post(`https://user-api.gluehome.com/v1/locks/${lockId}/operations`, body, options)
      .then((response) => {
        console.log("Command send", response.data);
      })
      .catch((error) => {
        console.log("ERROR", error);
      })
      .finally(() => {
        // always executed
      });
  }
}

module.exports = GlueDevice;
