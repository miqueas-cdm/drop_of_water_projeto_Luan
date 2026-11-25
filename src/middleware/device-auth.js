'use strict';

const { HttpError, asyncRoute } = require('../lib/errors');
const { deviceKeyMatches } = require('../lib/security');

function requireDevice(pool, { allowUnauthenticatedDeviceAccess = false } = {}) {
  return asyncRoute(async (req, res, next) => {
    const headerDeviceId = req.get('X-Device-Id');
    const key = req.get('X-Device-Key');
    const publicRoute = (req.method === 'GET' && ['/commands', '/ingest', '/commands/ack'].includes(req.path)) ||
      (req.method === 'POST' && (req.path === '/telemetry' || /^\/commands\/[1-9]\d*\/ack$/.test(req.path)));
    const queryDeviceId = req.query.dispositivo_id;
    const publicAccess = allowUnauthenticatedDeviceAccess && publicRoute && !key &&
      typeof queryDeviceId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(queryDeviceId) &&
      (!headerDeviceId || headerDeviceId === queryDeviceId);
    const deviceId = publicAccess ? queryDeviceId : headerDeviceId;
    if (!deviceId || (!key && !publicAccess) || deviceId.length > 64 || (key && key.length > 128)) {
      throw new HttpError(401, 'Device authentication required.');
    }
    const [rows] = await pool.execute(
      'SELECT device_id, key_hash, status, allow_get, require_nonce, interval_sec FROM devices WHERE device_id = ? LIMIT 1',
      [deviceId]
    );
    if (rows.length === 0 || (!publicAccess && !deviceKeyMatches(key, rows[0].key_hash))) {
      throw new HttpError(401, 'Device authentication failed.');
    }
    if (rows[0].status !== 'active') throw new HttpError(403, 'Device access is disabled.');
    req.device = rows[0];
    req.unauthenticatedDeviceAccess = publicAccess;
    next();
  });
}

module.exports = { requireDevice };
