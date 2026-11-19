'use strict';

const bcrypt = require('bcryptjs');
const express = require('express');
const { asyncRoute, HttpError } = require('../lib/errors');
const { createToken } = require('../lib/security');
const { validate, validateQueryPolicy } = require('../middleware/validate');
const schemas = require('../validation/schemas');

function createAuthRouter(pool, loginLimiter) {
  const router = express.Router();

  router.post('/auth/register', validateQueryPolicy([]), loginLimiter, validate({ body: schemas.register }), asyncRoute(async (req, res) => {
    const { email, password } = req.validated.body;
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const [result] = await pool.execute(
        'INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
        [email, passwordHash, 'user']
      );
      res.status(201).json({ id: result.insertId, email, role: 'user' });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Account could not be created.');
      throw error;
    }
  }));

  router.post('/auth/login', validateQueryPolicy([]), loginLimiter, validate({ body: schemas.login }), asyncRoute(async (req, res) => {
    const { email, password } = req.validated.body;
    const [rows] = await pool.execute(
      'SELECT id, email, password_hash, role, status FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    if (rows.length === 0 || rows[0].role !== 'user' || rows[0].status !== 'active') {
      throw new HttpError(401, 'Invalid email or password.');
    }
    const matches = await bcrypt.compare(password, rows[0].password_hash);
    if (!matches) throw new HttpError(401, 'Invalid email or password.');
    res.json({
      token: createToken(rows[0]),
      expires_in: 3600,
      user: { id: rows[0].id, email: rows[0].email, role: 'user' }
    });
  }));

  router.post('/admin/login', validateQueryPolicy([]), loginLimiter, validate({ body: schemas.login }), asyncRoute(async (req, res) => {
    const { email, password } = req.validated.body;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, email, password_hash, role, status, failed_login_attempts,
                locked_until, (locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP()) AS is_locked
         FROM users WHERE email = ? LIMIT 1 FOR UPDATE`,
        [email]
      );
      const user = rows[0];
      if (!user || user.role !== 'admin' || user.status !== 'active' || Number(user.is_locked) === 1) {
        await connection.rollback();
        throw new HttpError(401, 'Invalid email or password.');
      }

      const matches = await bcrypt.compare(password, user.password_hash);
      if (!matches) {
        await connection.execute(
          `UPDATE users
           SET locked_until = IF(failed_login_attempts + 1 >= 5,
                 DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE), locked_until),
               failed_login_attempts = LEAST(failed_login_attempts + 1, 5)
           WHERE id = ?`,
          [user.id]
        );
        await connection.commit();
        throw new HttpError(401, 'Invalid email or password.');
      }

      await connection.execute(
        'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?',
        [user.id]
      );
      await connection.commit();
      res.json({
        token: createToken(user),
        expires_in: 3600,
        user: { id: user.id, email: user.email, role: 'admin' }
      });
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }));

  return router;
}

module.exports = { createAuthRouter };
