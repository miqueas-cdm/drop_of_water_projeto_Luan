'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { HttpError } = require('./errors');

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
  }
  return secret;
}

function createToken(user) {
  return jwt.sign({ role: user.role }, jwtSecret(), {
    subject: String(user.id),
    expiresIn: '1h',
    issuer: 'drop-of-water-api',
    audience: 'drop-of-water-app'
  });
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret(), {
    issuer: 'drop-of-water-api',
    audience: 'drop-of-water-app',
    algorithms: ['HS256']
  });
}

function generateDeviceKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashDeviceKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function deviceKeyMatches(key, expectedHash) {
  const actual = Buffer.from(hashDeviceKey(key), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  if (!match) throw new HttpError(401, 'Authentication required.');
  return match[1];
}

module.exports = {
  createToken,
  deviceKeyMatches,
  generateDeviceKey,
  hashDeviceKey,
  verifyToken,
  bearerToken
};
