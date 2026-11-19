'use strict';

const { asyncRoute, HttpError } = require('../lib/errors');
const { bearerToken, verifyToken } = require('../lib/security');

function requireAuth(pool, roles) {
  return asyncRoute(async (req, res, next) => {
    let payload;
    try {
      payload = verifyToken(bearerToken(req));
    } catch (error) {
      if (error instanceof HttpError) return next(error);
      throw new HttpError(401, 'Authentication required.');
    }
    if (!roles.includes(payload.role)) throw new HttpError(403, 'Access denied.');
    const userId = Number(payload.sub);
    const [rows] = await pool.execute(
      'SELECT id, role, status FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    if (rows.length === 0 || rows[0].status !== 'active') {
      throw new HttpError(401, 'Authentication required.');
    }
    if (rows[0].role !== payload.role) throw new HttpError(403, 'Access denied.');
    req.auth = { id: userId, role: payload.role };
    next();
  });
}

module.exports = { requireAuth };
