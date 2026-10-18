'use strict';

const https = require('https');

const HOST = 'user-api.gluehome.com';
const SCOPES = ['events.read', 'locks.read', 'locks.write'];

function apiError(code, message, statusCode) {
  const err = new Error(message);
  err.code = code;
  if (statusCode) err.statusCode = statusCode;
  return err;
}

/**
 * Pulls the API key out of the response from POST /v1/api-keys.
 * The response format is not documented, so this accepts a plain string,
 * a known field name, or otherwise the longest long string in the object.
 */
function extractKey(data) {
  if (typeof data === 'string') {
    const s = data.trim();
    return s.length >= 20 ? s : null;
  }
  if (!data || typeof data !== 'object') return null;

  for (const name of ['apiKey', 'api_key', 'key', 'token', 'secret', 'value']) {
    if (typeof data[name] === 'string' && data[name].length >= 20) return data[name];
  }

  let best = null;
  const walk = value => {
    if (typeof value === 'string') {
      if (value.length >= 40 && (!best || value.length > best.length)) best = value;
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(data);
  return best;
}

/**
 * Minimal client for the Glue user API (https://user-api.gluehome.com/v1).
 * The API key is fetched through a callback on every request, so it is never
 * kept in this object and never logged. Passwords are only passed to
 * createApiKey, used once, and never stored or logged.
 */
class GlueApi {

  constructor(getKey) {
    this._getKey = getKey;
  }

  _send({ method, path, headers, body }) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const allHeaders = Object.assign({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }, headers);
      if (data) allHeaders['Content-Length'] = Buffer.byteLength(data);

      const req = https.request({
        hostname: HOST,
        path: `/v1${path}`,
        method,
        headers: allHeaders,
        timeout: 15000,
      }, res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { buf += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text: buf }));
      });

      req.on('timeout', () => req.destroy(apiError('TIMEOUT', 'Timeout talking to the Glue API.')));
      req.on('error', err => reject(err.code ? err : apiError('NETWORK', err.message)));
      if (data) req.write(data);
      req.end();
    });
  }

  async _request(method, path, body) {
    const key = this._getKey();
    if (!key) throw apiError('NO_KEY', 'No API key set.');

    const res = await this._send({
      method,
      path,
      body,
      headers: { Authorization: `Api-Key ${key}` },
    });

    if (res.status === 401 || res.status === 403) {
      throw apiError('INVALID_KEY', `Invalid API key or missing permission (${res.status}).`, res.status);
    }
    if (res.status < 200 || res.status >= 300) {
      throw apiError('HTTP', `Glue API responded ${res.status}: ${res.text.slice(0, 200)}`, res.status);
    }
    if (!res.text) return null;
    try {
      return JSON.parse(res.text);
    } catch (err) {
      return res.text;
    }
  }

  /** @returns {Promise<Array>} all locks on the account */
  getLocks() {
    return this._request('GET', '/locks');
  }

  /** @param {'lock'|'unlock'} type */
  operate(lockId, type) {
    if (type !== 'lock' && type !== 'unlock') {
      return Promise.reject(apiError('BAD_ACTION', `Unknown action: ${type}`));
    }
    return this._request('POST', `/locks/${encodeURIComponent(lockId)}/operations`, { type });
  }

  /**
   * Exchanges the user's Glue login for an API key. The credentials are only
   * used for this one request.
   * @returns {Promise<string>} the API key
   */
  async createApiKey(username, password, keyName) {
    const basic = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    const res = await this._send({
      method: 'POST',
      path: '/api-keys',
      headers: { Authorization: `Basic ${basic}` },
      body: { name: keyName, scopes: SCOPES },
    });

    if (res.status === 401 || res.status === 403) {
      throw apiError('INVALID_CREDENTIALS', 'Invalid login.', res.status);
    }
    if (res.status < 200 || res.status >= 300) {
      throw apiError('HTTP', `Glue API responded ${res.status}`, res.status);
    }

    let parsed = res.text;
    try {
      parsed = JSON.parse(res.text);
    } catch (err) {
      // plain-text response, handled by extractKey
    }

    const key = extractKey(parsed);
    if (!key) throw apiError('UNEXPECTED_RESPONSE', 'Unexpected response when creating the API key.');
    return key;
  }

}

GlueApi.extractKey = extractKey;
GlueApi.SCOPES = SCOPES;

module.exports = GlueApi;
