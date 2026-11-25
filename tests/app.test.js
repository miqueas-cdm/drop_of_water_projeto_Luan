'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const createApp = require('../src/app');
const { createToken, hashDeviceKey } = require('../src/lib/security');

test('HTTP flow authenticates devices, rejects replay and scopes telemetry to its owner', async (t) => {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  const deviceKey = 'test-device-key';
  const keyHash = hashDeviceKey(deviceKey);
  const telemetryRows = [];
  const nonces = new Set();
  const device = (deviceId) => ({
    device_id: deviceId,
    key_hash: keyHash,
    status: 'active',
    allow_get: 1,
    require_nonce: 1,
    interval_sec: 60
  });
  const pool = {
    async query() {
      return [[{ ready: 1 }], []];
    },
    async execute(sql, params) {
      if (sql.includes('SELECT id, role, status FROM users WHERE id = ?')) {
        return [[{ id: params[0], role: Number(params[0]) === 1 ? 'admin' : 'user', status: 'active' }], []];
      }
      if (sql.includes('FROM devices WHERE device_id = ? LIMIT 1')) {
        return [[device(params[0])], []];
      }
      if (sql.includes('INSERT INTO used_nonces')) {
        const key = `${params[0]}:${params[1]}`;
        if (nonces.has(key)) {
          const error = new Error('Duplicate nonce');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
        nonces.add(key);
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('INSERT INTO telemetry')) {
        telemetryRows.push({
          id: telemetryRows.length + 1,
          device_id: params[0],
          payload: JSON.parse(params[1]),
          created_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
        });
        return [{ insertId: telemetryRows.length }, []];
      }
      if (sql.includes('FROM devices d INNER JOIN user_devices')) {
        if (Number(params[0]) !== 42) return [[], []];
        return [[{
          device_id: params[1],
          name: 'Test sensor',
          status: 'active',
          interval_sec: 60,
          last_seen_at: new Date(),
          online: 1
        }], []];
      }
      if (sql.includes('SELECT id, payload, created_at FROM telemetry')) {
        const rows = telemetryRows.filter((item) => item.device_id === params[0]).reverse();
        return [rows.slice(0, 1), []];
      }
      if (sql.includes('SELECT COUNT(*) AS total FROM telemetry')) {
        return [[{ total: telemetryRows.length }], []];
      }
      if (sql.includes('SELECT COUNT(*) AS count FROM commands')) {
        return [[{ count: 0 }], []];
      }
      if (sql.includes('SELECT id, payload, created_at FROM telemetry WHERE')) {
        return [telemetryRows.filter((item) => item.device_id === params[0]).reverse(), []];
      }
      return [{ affectedRows: 1, insertId: telemetryRows.length }, []];
    }
  };
  pool.getConnection = async () => ({
    execute: pool.execute.bind(pool),
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {}
  });
  const server = createApp({ pool }).listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const deviceHeaders = (deviceId, key = deviceKey) => ({
    'X-Device-Id': deviceId,
    'X-Device-Key': key
  });
  const postTelemetry = (deviceId, payload) => fetch(`${base}/device/telemetry`, {
    method: 'POST',
    headers: { ...deviceHeaders(deviceId), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const userToken = createToken({ id: 42, role: 'user' });
  const otherUserToken = createToken({ id: 43, role: 'user' });
  const adminToken = createToken({ id: 1, role: 'admin' });

  const health = await fetch(`${base}/health`);
  assert.deepEqual(await health.json(), { status: 'ok', db: 'ok' });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/device/ping`)).status, 401);
  assert.equal((await fetch(`${base}/device/ping?device_key=never-put-credentials-in-a-url`)).status, 400);
  assert.equal((await fetch(`${base}/device/ping`, {
    headers: deviceHeaders('invalid-key-device', 'wrong-key')
  })).status, 401);
  assert.equal((await fetch(`${base}/device/ping?extra=1`, {
    headers: deviceHeaders('query-device')
  })).status, 400);
  assert.equal((await postTelemetry('invalid-body-device', { temp: 20, unexpected: true })).status, 400);

  const postResult = await postTelemetry('sensor-test', { temp: 21.5, hum: 50 });
  assert.equal(postResult.status, 201);
  assert.equal((await postTelemetry('sensor-test-2', { temp: 130 })).status, 400);

  const latestResponse = await fetch(`${base}/devices/sensor-test/telemetry/latest`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.equal(latestResponse.status, 200);
  assert.equal((await latestResponse.json()).reading.payload.temp, 21.5);

  const privateResponse = await fetch(`${base}/devices/sensor-test`, {
    headers: { Authorization: `Bearer ${otherUserToken}` }
  });
  assert.equal(privateResponse.status, 404);
  assert.equal((await fetch(`${base}/admin/stats`, {
    headers: { Authorization: `Bearer ${userToken}` }
  })).status, 403);
  assert.equal((await fetch(`${base}/devices/sensor-test`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  })).status, 403);

  await new Promise((resolve) => setTimeout(resolve, 1050));
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const url = `${base}/device/ingest?temp=22.3&hum=51&ts=${ts}&nonce=${nonce}`;
  const ingestion = await fetch(url, { headers: deviceHeaders('sensor-test') });
  assert.equal(ingestion.status, 200);
  assert.equal((await ingestion.json()).ok, true);

  await new Promise((resolve) => setTimeout(resolve, 1050));
  const replay = await fetch(url, { headers: deviceHeaders('sensor-test') });
  assert.equal(replay.status, 409);

  const latestAfterGet = await fetch(`${base}/devices/sensor-test/telemetry/latest`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.equal((await latestAfterGet.json()).reading.payload.temp, 22.3);
  assert.equal(telemetryRows.filter((row) => row.device_id === 'sensor-test').length, 2);
});

test('temporary public device access is opt-in and limited to active devices and device operations', async (t) => {
  const oldSecret = process.env.JWT_SECRET;
  const oldPublicAccess = process.env.ALLOW_UNAUTHENTICATED_DEVICE_ACCESS;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  const recorded = [];
  const pool = {
    async execute(sql, params) {
      if (sql.includes('FROM devices WHERE device_id = ? LIMIT 1')) {
        if (params[0] === 'missing') return [[], []];
        return [[{
          device_id: params[0],
          key_hash: hashDeviceKey('test-device-key'),
          status: params[0] === 'inactive' ? 'inactive' : 'active',
          allow_get: 1,
          require_nonce: 1,
          interval_sec: 60
        }], []];
      }
      if (sql.includes('INSERT INTO telemetry')) recorded.push({ deviceId: params[0], payload: JSON.parse(params[1]) });
      if (sql.includes('SELECT id, command FROM commands')) return [[{ id: 1, command: 'status' }], []];
      if (sql.includes('SELECT COUNT(*) AS count FROM commands')) return [[{ count: 0 }], []];
      return [{ affectedRows: 1 }, []];
    }
  };
  pool.getConnection = async () => ({
    execute: pool.execute.bind(pool),
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {}
  });
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
    if (oldPublicAccess === undefined) delete process.env.ALLOW_UNAUTHENTICATED_DEVICE_ACCESS;
    else process.env.ALLOW_UNAUTHENTICATED_DEVICE_ACCESS = oldPublicAccess;
  });
  const start = async (enabled) => {
    if (enabled) process.env.ALLOW_UNAUTHENTICATED_DEVICE_ACCESS = 'true';
    else delete process.env.ALLOW_UNAUTHENTICATED_DEVICE_ACCESS;
    const server = createApp({ pool }).listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    return `http://127.0.0.1:${server.address().port}/api/v1`;
  };
  let ip = 0;
  const request = (base, path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { 'X-Forwarded-For': `192.0.2.${++ip}`, ...options.headers }
  });

  const secure = await start(false);
  assert.equal((await request(secure, '/device/commands?dispositivo_id=sensor')).status, 401);
  assert.equal((await request(secure, '/device/telemetry?dispositivo_id=sensor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ temp: 24.5 })
  })).status, 401);
  const publicBase = await start(true);
  const commands = await request(publicBase, '/device/commands?dispositivo_id=sensor');
  assert.equal(commands.status, 200);
  assert.deepEqual(await commands.json(), { commands: [{ id: 1, command: 'status' }] });
  const post = await request(publicBase, '/device/telemetry?dispositivo_id=sensor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ temp: 24.5 })
  });
  assert.equal(post.status, 201);
  assert.deepEqual(recorded[0], { deviceId: 'sensor', payload: { temp: 24.5 } });
  const ts = Math.floor(Date.now() / 1000);
  assert.equal((await request(publicBase, `/device/ingest?dispositivo_id=sensor&temp=23&ts=${ts}&nonce=12345678`)).status, 200);
  assert.equal((await request(publicBase, '/device/commands/ack?dispositivo_id=sensor&id=1&status=done')).status, 200);
  assert.equal((await request(publicBase, '/device/commands/1/ack?dispositivo_id=sensor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' })
  })).status, 200);
  assert.equal((await request(publicBase, '/device/commands?dispositivo_id=missing')).status, 401);
  assert.equal((await request(publicBase, '/device/commands?dispositivo_id=inactive')).status, 403);
  assert.equal((await request(publicBase, '/device/commands?dispositivo_id=sensor&dispositivo_id=other')).status, 401);
  assert.equal((await request(publicBase, '/device/commands?dispositivo_id=sensor', {
    headers: { 'X-Device-Id': 'other-sensor' }
  })).status, 401);
  assert.equal((await request(publicBase, '/device/commands?dispositivo_id=sensor&extra=1')).status, 400);
  assert.equal((await request(publicBase, '/device/ingest?dispositivo_id=sensor&temp=23')).status, 400);
  assert.equal((await request(publicBase, '/device/config?dispositivo_id=sensor')).status, 401);
  assert.equal((await request(publicBase, '/device/commands?dispositivo_id=sensor', {
    headers: { 'X-Device-Id': 'sensor', 'X-Device-Key': 'wrong-key' }
  })).status, 401);
  assert.equal((await request(publicBase, '/device/ping', {
    headers: { 'X-Device-Id': 'authenticated-sensor', 'X-Device-Key': 'test-device-key' }
  })).status, 200);
});
