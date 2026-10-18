'use strict';

module.exports = {
  async getTest({ homey }) {
    return homey.app.testConnection();
  },

  async getStatus({ homey }) {
    return { loggedIn: homey.app.hasKey() };
  },

  async postLogin({ homey, body }) {
    await homey.app.login(body || {});
    return { ok: true };
  },

  async postLogout({ homey }) {
    homey.app.logout();
    return { ok: true };
  },
};
