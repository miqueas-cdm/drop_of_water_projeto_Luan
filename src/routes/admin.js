'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const express = require('express');
const { asyncRoute, HttpError } = require('../lib/errors');
const { generateDeviceKey, hashDeviceKey } = require('../lib/security');
const { requireAuth } = require('../middleware/auth');
const { validate, validateQueryPolicy } = require('../middleware/validate');
const schemas = require('../validation/schemas');

function createAdminRouter(pool) {
  const router = express.Router();
  router.use(requireAuth(pool, ['admin']));
  router.use(validateQueryPolicy(['/audit', '/logs']));

  router.get('/stats', asyncRoute(async (req, res) => {
    const [[deviceStats]] = await pool.execute(
      `SELECT COUNT(*) AS total,
        SUM(status = 'active' AND last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL (2 * interval_sec) SECOND)) AS online
       FROM devices`
    );
    const [[readingStats]] = await pool.execute(
      'SELECT COUNT(*) AS readings_24h FROM telemetry WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)'
    );
    const [latest] = await pool.execute(
      'SELECT device_id, payload, created_at FROM telemetry ORDER BY created_at DESC, id DESC LIMIT 24'
    );
    res.json({
      devices: {
        total: Number(deviceStats.total),
        online: Number(deviceStats.online || 0),
        offline: Number(deviceStats.total) - Number(deviceStats.online || 0)
      },
      readings_24h: Number(readingStats.readings_24h),
      recent_telemetry: latest
    });
  }));

  router.get('/devices', asyncRoute(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT d.device_id, d.name, d.status, d.allow_get, d.require_nonce, d.interval_sec,
              d.last_seen_at,
              (d.last_seen_at IS NOT NULL AND d.last_seen_at >=
                DATE_SUB(UTC_TIMESTAMP(), INTERVAL (2 * d.interval_sec) SECOND)) AS online,
              GROUP_CONCAT(ud.user_id ORDER BY ud.user_id) AS user_ids
       FROM devices d LEFT JOIN user_devices ud ON ud.device_id = d.device_id
       GROUP BY d.device_id ORDER BY d.created_at DESC`
    );
    res.json({
      devices: rows.map((row) => ({
        ...row,
        allow_get: Number(row.allow_get) === 1,
        require_nonce: Number(row.require_nonce) === 1,
        online: Number(row.online) === 1
      }))
    });
  }));

  router.post('/devices', validate({ body: schemas.deviceCreate }), asyncRoute(async (req, res) => {
    const values = req.validated.body;
    const key = generateDeviceKey();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO devices (device_id, name, key_hash, allow_get, require_nonce, interval_sec, created_at)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [
          values.device_id, values.name, hashDeviceKey(key),
          values.allow_get === undefined ? 1 : Number(values.allow_get),
          values.require_nonce === undefined ? 1 : Number(values.require_nonce),
          values.interval_sec || 60
        ]
      );
      if (values.user_id) await linkDevice(connection, values.user_id, values.device_id);
      await audit(connection, req.auth.id, 'device.create', 'device', values.device_id);
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Device could not be created.');
      throw error;
    } finally {
      connection.release();
    }
    res.status(201).json({
      device_id: values.device_id,
      device_key: key,
      warning: 'Copy this key now. It cannot be shown again.'
    });
  }));

  router.put('/devices/:id', validate({
    params: schemas.idParams,
    body: schemas.deviceUpdate
  }), asyncRoute(async (req, res) => {
    const { id } = req.validated.params;
    const changes = req.validated.body;
    const columns = Object.keys(changes);
    const [[device]] = await pool.execute('SELECT device_id FROM devices WHERE device_id = ? LIMIT 1', [id]);
    if (!device) throw new HttpError(404, 'Device not found.');
    await pool.execute(
      `UPDATE devices SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE device_id = ?`,
      [...columns.map((column) => typeof changes[column] === 'boolean' ? Number(changes[column]) : changes[column]), id]
    );
    await audit(pool, req.auth.id, 'device.update', 'device', id, changes);
    res.json({ ok: true });
  }));

  router.post('/devices/:id/rotate-key', validate({ params: schemas.idParams }), asyncRoute(async (req, res) => {
    const { id } = req.validated.params;
    const key = generateDeviceKey();
    const [result] = await pool.execute(
      'UPDATE devices SET key_hash = ? WHERE device_id = ?',
      [hashDeviceKey(key), id]
    );
    if (result.affectedRows !== 1) throw new HttpError(404, 'Device not found.');
    await audit(pool, req.auth.id, 'device.rotate_key', 'device', id);
    res.json({ device_id: id, device_key: key, warning: 'Copy this key now. It cannot be shown again.' });
  }));

  router.post('/devices/:id/revoke-key', validate({ params: schemas.idParams }), asyncRoute(async (req, res) => {
    const { id } = req.validated.params;
    const [[device]] = await pool.execute('SELECT device_id FROM devices WHERE device_id = ? LIMIT 1', [id]);
    if (!device) throw new HttpError(404, 'Device not found.');
    const randomHash = crypto.randomBytes(32).toString('hex');
    await pool.execute(
      "UPDATE devices SET key_hash = ?, status = 'inactive' WHERE device_id = ?",
      [randomHash, id]
    );
    await audit(pool, req.auth.id, 'device.revoke_key', 'device', id);
    res.json({ ok: true });
  }));

  router.delete('/devices/:id', validate({ params: schemas.idParams }), asyncRoute(async (req, res) => {
    const { id } = req.validated.params;
    const [[device]] = await pool.execute('SELECT device_id FROM devices WHERE device_id = ? LIMIT 1', [id]);
    if (!device) throw new HttpError(404, 'Device not found.');
    await pool.execute(
      "UPDATE devices SET status = 'inactive' WHERE device_id = ?",
      [id]
    );
    await audit(pool, req.auth.id, 'device.deactivate', 'device', id);
    res.status(204).end();
  }));

  router.get('/users', asyncRoute(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT u.id, u.email, u.role, u.status, u.created_at,
              GROUP_CONCAT(ud.device_id ORDER BY ud.device_id) AS device_ids
       FROM users u LEFT JOIN user_devices ud ON ud.user_id = u.id
       WHERE u.role = 'user' GROUP BY u.id ORDER BY u.created_at DESC`
    );
    res.json({ users: rows });
  }));

  router.post('/users', validate({ body: schemas.adminUserCreate }), asyncRoute(async (req, res) => {
    const { email, password } = req.validated.body;
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const [result] = await pool.execute(
        'INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
        [email, passwordHash, 'user']
      );
      await audit(pool, req.auth.id, 'user.create', 'user', result.insertId);
      res.status(201).json({ id: result.insertId, email });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'User could not be created.');
      throw error;
    }
  }));

  router.put('/users/:userId', validate({
    params: schemas.userIdParams,
    body: schemas.adminUserUpdate
  }), asyncRoute(async (req, res) => {
    const { userId } = req.validated.params;
    const values = { ...req.validated.body };
    if (values.password) {
      values.password_hash = await bcrypt.hash(values.password, 12);
      delete values.password;
    }
    const columns = Object.keys(values);
    try {
      const [[user]] = await pool.execute(
        "SELECT id FROM users WHERE id = ? AND role = 'user' LIMIT 1",
        [userId]
      );
      if (!user) throw new HttpError(404, 'User not found.');
      await pool.execute(
        `UPDATE users SET ${columns.map((column) => `${column} = ?`).join(', ')}
         WHERE id = ? AND role = 'user'`,
        [...Object.values(values), userId]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'User could not be updated.');
      throw error;
    }
    await audit(pool, req.auth.id, 'user.update', 'user', userId, { ...req.validated.body, password: undefined });
    res.json({ ok: true });
  }));

  router.delete('/users/:userId', validate({ params: schemas.userIdParams }), asyncRoute(async (req, res) => {
    const { userId } = req.validated.params;
    const [result] = await pool.execute(
      "UPDATE users SET status = 'inactive' WHERE id = ? AND role = 'user'",
      [userId]
    );
    if (result.affectedRows !== 1) throw new HttpError(404, 'User not found.');
    await audit(pool, req.auth.id, 'user.deactivate', 'user', userId);
    res.status(204).end();
  }));

  router.post('/users/:userId/devices', validate({
    params: schemas.userIdParams,
    body: schemas.userDeviceLink
  }), asyncRoute(async (req, res) => {
    const { userId } = req.validated.params;
    const { device_id: deviceId } = req.validated.body;
    await linkDevice(pool, userId, deviceId);
    await audit(pool, req.auth.id, 'device.link', 'user_device', `${userId}:${deviceId}`);
    res.status(201).json({ ok: true });
  }));

  router.delete('/users/:userId/devices/:deviceId', validate({
    params: schemas.userDeviceParams
  }), asyncRoute(async (req, res) => {
    const { userId, deviceId } = req.validated.params;
    const [result] = await pool.execute(
      'DELETE FROM user_devices WHERE user_id = ? AND device_id = ?',
      [userId, deviceId]
    );
    if (result.affectedRows !== 1) throw new HttpError(404, 'Link not found.');
    await audit(pool, req.auth.id, 'device.unlink', 'user_device', `${userId}:${deviceId}`);
    res.status(204).end();
  }));

  router.get('/audit', validate({ query: schemas.auditQuery }), auditHandler(pool));
  router.get('/logs', validate({ query: schemas.auditQuery }), auditHandler(pool));

  return router;
}

async function linkDevice(pool, userId, deviceId) {
  const [[user]] = await pool.execute(
    "SELECT id FROM users WHERE id = ? AND role = 'user' AND status = 'active' LIMIT 1",
    [userId]
  );
  const [[device]] = await pool.execute('SELECT device_id FROM devices WHERE device_id = ? LIMIT 1', [deviceId]);
  if (!user || !device) throw new HttpError(404, 'User or device not found.');
  try {
    await pool.execute(
      'INSERT INTO user_devices (user_id, device_id) VALUES (?, ?)',
      [userId, deviceId]
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Link already exists.');
    throw error;
  }
}

function auditHandler(pool) {
  return asyncRoute(async (req, res) => {
    const { limit } = req.validated.query;
    const [rows] = await pool.execute(
      `SELECT a.id, a.actor_user_id, u.email AS actor_email, a.action, a.target_type,
              a.target_id, a.details, a.created_at
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
      [limit]
    );
    res.json({ logs: rows });
  });
}

async function audit(pool, actorId, action, targetType, targetId, details) {
  await pool.execute(
    `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [actorId, action, targetType, String(targetId), details ? JSON.stringify(details) : null]
  );
}

module.exports = { createAdminRouter, audit, linkDevice };
