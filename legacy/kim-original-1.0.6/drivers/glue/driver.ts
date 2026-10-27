import Homey from 'homey';
import axios from 'axios';
import _ from 'underscore';

let lockCollection: { name: any; data: { id: any; }; }[] = [];

class GlueDriver extends Homey.Driver {


  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('GlueDriver has been initialized');
    this.loadLocksCollection();    
  }

  /**
   * onPairListDevices is called when a user is adding a device and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {    
    return lockCollection;
  }

  public loadLocksCollection = () => {
    // Arrange
    var glueLockAuth = this.homey.settings.get("GlueLockAuth");
    var options = {
      method: 'get',
      headers: {
        'Authorization': `Api-Key ${glueLockAuth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };


    axios.get("https://user-api.gluehome.com/v1/locks", options)
    .then(function (response) {
      var responseJson = response.data;
      
      lockCollection = _.map(responseJson, (lock) => {
        return {
          "name": lock.description,
          "data": {
            "id": lock.id
          }
        }
      });
      
    })
    .catch(function (error) {
      console.log("ERROR", error);
    })
    .finally(function () {
      // always executed
    }); 


  };
}

module.exports = GlueDriver;
