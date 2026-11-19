'use strict';

const { HttpError, asyncRoute } = require('../lib/errors');
const { deviceKeyMatches } = require('../lib/security');

function requireDevice(pool) {
  return asyncRoute(async (req, res, next) => {
    const deviceId = req.get('X-Device-Id');
    const key = req.get('X-Device-Key');
    if (!deviceId || !key || deviceId.length > 64 || key.length > 128) {
      throw new HttpError(401, 'Device authentication required.');
    }
    const [rows] = await pool.execute(
      'SELECT device_id, key_hash, status, allow_get, require_nonce, interval_sec FROM devices WHERE device_id = ? LIMIT 1',
      [deviceId]
    );
    if (rows.length === 0 || !deviceKeyMatches(key, rows[0].key_hash)) {
      throw new HttpError(401, 'Device authentication failed.');
    }
    if (rows[0].status !== 'active') throw new HttpError(403, 'Device access is disabled.');
    req.device = rows[0];
    next();
  });
}

module.exports = { requireDevice };
