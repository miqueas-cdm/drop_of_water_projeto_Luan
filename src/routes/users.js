'use strict';

const express = require('express');
const { asyncRoute, HttpError } = require('../lib/errors');
const { requireAuth } = require('../middleware/auth');
const { validate, validateQueryPolicy } = require('../middleware/validate');
const schemas = require('../validation/schemas');

function createUsersRouter(pool, readLimiter) {
  const router = express.Router();
  router.use('/devices', readLimiter);
  router.use('/devices', requireAuth(pool, ['user']));
  router.use('/devices', validateQueryPolicy([/^\/devices\/[^/]+\/telemetry$/]));

  router.get('/devices', asyncRoute(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT d.device_id, d.name, d.status, d.interval_sec, d.last_seen_at,
              (d.last_seen_at IS NOT NULL AND d.last_seen_at >=
                DATE_SUB(UTC_TIMESTAMP(), INTERVAL (2 * d.interval_sec) SECOND)) AS online
       FROM devices d INNER JOIN user_devices ud ON ud.device_id = d.device_id
       WHERE ud.user_id = ? AND d.status = 'active' ORDER BY d.name`,
      [req.auth.id]
    );
    res.json({ devices: rows.map(withBooleanOnline) });
  }));

  router.get('/devices/:id', validate({ params: schemas.idParams }), asyncRoute(async (req, res) => {
    const device = await findOwnedDevice(pool, req.auth.id, req.validated.params.id);
    res.json(withBooleanOnline(device));
  }));

  router.get('/devices/:id/telemetry/latest', validate({ params: schemas.idParams }), asyncRoute(async (req, res) => {
    const deviceId = req.validated.params.id;
    await findOwnedDevice(pool, req.auth.id, deviceId);
    const [rows] = await pool.execute(
      'SELECT id, payload, created_at FROM telemetry WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [deviceId]
    );
    res.json({ reading: rows[0] || null });
  }));

  router.get('/devices/:id/telemetry', validate({
    params: schemas.idParams,
    query: schemas.pageQuery
  }), asyncRoute(async (req, res) => {
    const deviceId = req.validated.params.id;
    const { from, to, page, limit } = req.validated.query;
    await findOwnedDevice(pool, req.auth.id, deviceId);
    const conditions = ['device_id = ?'];
    const values = [deviceId];
    if (from) {
      conditions.push('created_at >= ?');
      values.push(new Date(from));
    }
    if (to) {
      conditions.push('created_at <= ?');
      values.push(new Date(to));
    }
    const where = conditions.join(' AND ');
    const [[count]] = await pool.execute(`SELECT COUNT(*) AS total FROM telemetry WHERE ${where}`, values);
    const offset = (page - 1) * limit;
    const [items] = await pool.execute(
      `SELECT id, payload, created_at FROM telemetry WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );
    res.json({ items, page, limit, total: Number(count.total) });
  }));

  router.post('/devices/:id/commands', validate({
    params: schemas.idParams,
    body: schemas.commandCreate
  }), asyncRoute(async (req, res) => {
    const deviceId = req.validated.params.id;
    const device = await findOwnedDevice(pool, req.auth.id, deviceId);
    if (device.status !== 'active') throw new HttpError(403, 'Device is disabled.');
    const [result] = await pool.execute(
      'INSERT INTO commands (device_id, command, created_at) VALUES (?, ?, UTC_TIMESTAMP())',
      [deviceId, req.validated.body.command]
    );
    res.status(201).json({ id: result.insertId, status: 'pending' });
  }));

  return router;
}

async function findOwnedDevice(pool, userId, deviceId) {
  const [rows] = await pool.execute(
    `SELECT d.device_id, d.name, d.status, d.interval_sec, d.last_seen_at,
            (d.last_seen_at IS NOT NULL AND d.last_seen_at >=
              DATE_SUB(UTC_TIMESTAMP(), INTERVAL (2 * d.interval_sec) SECOND)) AS online
     FROM devices d INNER JOIN user_devices ud ON ud.device_id = d.device_id
     WHERE ud.user_id = ? AND ud.device_id = ? LIMIT 1`,
    [userId, deviceId]
  );
  if (rows.length === 0) throw new HttpError(404, 'Device not found.');
  return rows[0];
}

function withBooleanOnline(device) {
  return { ...device, online: Number(device.online) === 1 };
}

module.exports = { createUsersRouter, findOwnedDevice };
