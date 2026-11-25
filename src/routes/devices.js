'use strict';

const express = require('express');
const { asyncRoute, HttpError } = require('../lib/errors');
const { requireDevice } = require('../middleware/device-auth');
const { validate, validateQueryPolicy } = require('../middleware/validate');
const schemas = require('../validation/schemas');

function createDeviceRouter(pool, deviceLimiter, options) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (req.method === 'GET') res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(deviceLimiter);
  router.use(requireDevice(pool, options));
  const validateAuthenticatedQuery = validateQueryPolicy(['/device/ingest', '/device/commands/ack']);
  router.use((req, res, next) => {
    if (!req.unauthenticatedDeviceAccess) return validateAuthenticatedQuery(req, res, next);
    delete req.query.dispositivo_id;
    if ((req.path === '/commands' || req.method === 'POST') && Object.keys(req.query).length) {
      return next(new HttpError(400, 'Invalid request.'));
    }
    next();
  });

  router.get('/ping', asyncRoute(async (req, res) => {
    await touchDevice(pool, req.device.device_id);
    res.json({ ok: true, device_id: req.device.device_id });
  }));

  router.get('/config', asyncRoute(async (req, res) => {
    await touchDevice(pool, req.device.device_id);
    res.set('Cache-Control', 'no-store');
    res.json({
      interval_sec: req.device.interval_sec,
      allow_get: Number(req.device.allow_get) === 1,
      require_nonce: Number(req.device.require_nonce) === 1
    });
  }));

  router.get('/commands', asyncRoute(async (req, res) => {
    await touchDevice(pool, req.device.device_id);
    const [commands] = await pool.execute(
      'SELECT id, command FROM commands WHERE device_id = ? AND status = ? ORDER BY id ASC LIMIT 20',
      [req.device.device_id, 'pending']
    );
    if (commands.length) {
      const ids = commands.map((command) => command.id);
      await pool.execute(
        `UPDATE commands SET status = 'sent', sent_at = UTC_TIMESTAMP()
         WHERE device_id = ? AND status = 'pending' AND id IN (${ids.map(() => '?').join(',')})`,
        [req.device.device_id, ...ids]
      );
    }
    res.set('Cache-Control', 'no-store').json({ commands });
  }));

  router.get('/commands/ack', validate({ query: schemas.ackQuery }), asyncRoute(async (req, res) => {
    await acknowledge(pool, req.device.device_id, req.validated.query.id);
    res.json({ ok: true });
  }));

  router.post('/commands/:commandId/ack', validate({
    params: schemas.commandIdParams,
    body: schemas.ackBody
  }), asyncRoute(async (req, res) => {
    await acknowledge(pool, req.device.device_id, req.validated.params.commandId);
    res.json({ ok: true });
  }));

  router.get('/ingest', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (Buffer.byteLength(req.originalUrl, 'utf8') > 1024 || Object.keys(req.query).length > 20) {
      throw new HttpError(400, 'Invalid request.');
    }
    if (Number(req.device.allow_get) !== 1) throw new HttpError(403, 'GET ingestion is disabled.');
    const parsed = schemas.getTelemetrySchema.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'Invalid request.');
    const { ts, nonce, ...payload } = parsed.data;
    if (Number(req.device.require_nonce) === 1 && (ts === undefined || nonce === undefined)) {
      throw new HttpError(400, 'Invalid request.');
    }
    if (ts !== undefined || nonce !== undefined) {
      if (ts === undefined || nonce === undefined || Math.abs(Math.floor(Date.now() / 1000) - ts) > 120) {
        throw new HttpError(400, 'Invalid request.');
      }
    }
    const pendingCommands = await recordTelemetry(pool, req.device.device_id, payload, nonce);
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      next_in: req.device.interval_sec,
      cmd: pendingCommands
    });
  }));

  router.post('/telemetry', validate({ body: schemas.telemetrySchema }), asyncRoute(async (req, res) => {
    await recordTelemetry(pool, req.device.device_id, req.validated.body);
    res.status(201).json({ ok: true });
  }));

  return router;
}

async function touchDevice(pool, deviceId) {
  await pool.execute('UPDATE devices SET last_seen_at = UTC_TIMESTAMP() WHERE device_id = ?', [deviceId]);
}

async function consumeNonce(pool, deviceId, nonce) {
  try {
    await pool.execute(
      `INSERT INTO used_nonces (device_id, nonce, expires_at, created_at)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE), UTC_TIMESTAMP())`,
      [deviceId, nonce]
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Request already processed.');
    throw error;
  }
}

async function recordTelemetry(pool, deviceId, payload, nonce) {
  await pool.execute('DELETE FROM used_nonces WHERE expires_at < UTC_TIMESTAMP()');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (nonce) await consumeNonce(connection, deviceId, nonce);
    await connection.execute(
      'INSERT INTO telemetry (device_id, payload, created_at) VALUES (?, ?, UTC_TIMESTAMP())',
      [deviceId, JSON.stringify(payload)]
    );
    await connection.execute(
      'DELETE FROM telemetry WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)'
    );
    await touchDevice(connection, deviceId);
    const [[pending]] = await connection.execute(
      "SELECT COUNT(*) AS count FROM commands WHERE device_id = ? AND status = 'pending'",
      [deviceId]
    );
    await connection.commit();
    return Number(pending.count);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function acknowledge(pool, deviceId, commandId) {
  const [result] = await pool.execute(
    `UPDATE commands SET status = 'acked', acked_at = UTC_TIMESTAMP()
     WHERE id = ? AND device_id = ? AND status IN ('pending','sent')`,
    [commandId, deviceId]
  );
  if (result.affectedRows !== 1) throw new HttpError(404, 'Command not found.');
}

module.exports = { createDeviceRouter, consumeNonce, recordTelemetry };
