'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createToken, deviceKeyMatches, generateDeviceKey, hashDeviceKey, verifyToken } = require('../src/lib/security');
const { findOwnedDevice } = require('../src/routes/users');
const schemas = require('../src/validation/schemas');

test('device keys are generated with 256 bits and only their hash is needed for verification', () => {
  const key = generateDeviceKey();
  assert.equal(Buffer.from(key, 'base64url').length, 32);
  const hash = hashDeviceKey(key);
  assert.equal(hash.length, 64);
  assert.equal(deviceKeyMatches(key, hash), true);
  assert.equal(deviceKeyMatches(`${key}x`, hash), false);
});

test('JWTs carry the caller role and a numeric subject', () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 't'.repeat(48);
  try {
    const token = createToken({ id: 27, role: 'user' });
    const payload = verifyToken(token);
    assert.equal(payload.sub, '27');
    assert.equal(payload.role, 'user');
    assert.equal(payload.exp - payload.iat, 3600);
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test('telemetry validation enforces sensor ranges and rejects unknown properties', () => {
  assert.equal(schemas.telemetrySchema.safeParse({ temp: 24.5, hum: 60 }).success, true);
  assert.equal(schemas.telemetrySchema.safeParse({ temp: 126 }).success, false);
  assert.equal(schemas.telemetrySchema.safeParse({ temp: 25, command: 'ignored' }).success, false);
  assert.equal(schemas.telemetrySchema.safeParse({}).success, false);
});

test('password validation rejects values bcrypt would truncate beyond 72 UTF-8 bytes', () => {
  assert.equal(schemas.register.safeParse({
    email: 'user@example.test',
    password: 'a'.repeat(72)
  }).success, true);
  assert.equal(schemas.register.safeParse({
    email: 'user@example.test',
    password: 'é'.repeat(37)
  }).success, false);
});

test('GET ingestion validation permits anti-replay metadata but rejects malformed input', () => {
  assert.equal(schemas.getTelemetrySchema.safeParse({
    temp: '22.4', ts: String(Math.floor(Date.now() / 1000)), nonce: '0123456789abcdef'
  }).success, true);
  assert.equal(schemas.getTelemetrySchema.safeParse({ temp: '22.4', unknown: '1' }).success, false);
  assert.equal(schemas.getTelemetrySchema.safeParse({ hum: '101' }).success, false);
  assert.equal(schemas.getTelemetrySchema.safeParse({ temp: '22.4', nonce: 'short' }).success, false);
});

test('device ownership lookup scopes the query by both user and device', async () => {
  let captured;
  const pool = {
    async execute(sql, params) {
      captured = { sql, params };
      return [[]];
    }
  };
  await assert.rejects(findOwnedDevice(pool, 14, 'sensor-private'), { status: 404 });
  assert.match(captured.sql, /ud\.user_id = \? AND ud\.device_id = \?/);
  assert.deepEqual(captured.params, [14, 'sensor-private']);
});
