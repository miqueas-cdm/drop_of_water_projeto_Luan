'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const createApp = require('../src/app');
const { initializeDatabase } = require('../src/db/schema');

const configured = ['TEST_DB_HOST', 'TEST_DB_USER', 'TEST_DB_NAME']
  .every((name) => Boolean(process.env[name]));

test('auth, ownership, validation, GET/POST ingestion and app history', { skip: !configured }, async (t) => {
  if (process.env.TEST_DB_NAME === process.env.DB_NAME) {
    throw new Error('TEST_DB_NAME must be different from DB_NAME.');
  }
  if (!process.env.TEST_DB_NAME.toLowerCase().includes('test')) {
    throw new Error('Use a dedicated TEST_DB_NAME containing "test".');
  }

  const previous = {
    adminEmail: process.env.ADMIN_EMAIL,
    adminPassword: process.env.ADMIN_PASSWORD,
    jwtSecret: process.env.JWT_SECRET
  };
  const suffix = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const adminEmail = `integration-admin-${suffix}@example.test`;
  const userEmail = `integration-user-${suffix}@example.test`;
  const otherEmail = `integration-other-${suffix}@example.test`;
  const password = 'Integration-Password-2026!';
  const deviceId = `integration-${suffix}`;
  process.env.ADMIN_EMAIL = adminEmail;
  process.env.ADMIN_PASSWORD = password;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');

  const pool = mysql.createPool({
    host: process.env.TEST_DB_HOST,
    port: Number(process.env.TEST_DB_PORT) || 3306,
    user: process.env.TEST_DB_USER,
    password: process.env.TEST_DB_PASSWORD || '',
    database: process.env.TEST_DB_NAME,
    waitForConnections: true,
    connectionLimit: 3,
    timezone: 'Z'
  });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.execute('DELETE FROM users WHERE email IN (?, ?, ?)', [adminEmail, userEmail, otherEmail]);
    await pool.execute('DELETE FROM devices WHERE device_id = ?', [deviceId]);
    await pool.end();
    if (previous.adminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previous.adminEmail;
    if (previous.adminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous.adminPassword;
    if (previous.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous.jwtSecret;
  });

  await initializeDatabase(pool);
  server = createApp({ pool }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const post = async (path, body, token) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const waitForDeviceLimit = () => new Promise((resolve) => setTimeout(resolve, 1100));

  const adminLogin = await post('/admin/login', { email: adminEmail, password });
  assert.equal(adminLogin.status, 200);
  const adminToken = (await adminLogin.json()).token;

  const invalidRegistration = await post('/auth/register', {
    email: userEmail, password, role: 'admin'
  });
  assert.equal(invalidRegistration.status, 400);
  const userRegistration = await post('/auth/register', { email: userEmail, password });
  assert.equal(userRegistration.status, 201);
  const otherRegistration = await post('/auth/register', { email: otherEmail, password });
  assert.equal(otherRegistration.status, 201);

  const createDevice = await post('/admin/devices', {
    device_id: deviceId, name: 'Integration device', require_nonce: true
  }, adminToken);
  assert.equal(createDevice.status, 201);
  const { device_key: deviceKey } = await createDevice.json();

  const userLogin = await post('/auth/login', { email: userEmail, password });
  const userToken = (await userLogin.json()).token;
  const otherLogin = await post('/auth/login', { email: otherEmail, password });
  const otherToken = (await otherLogin.json()).token;
  const user = await (await fetch(`${base}/admin/users`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  })).json();
  const userId = user.users.find((item) => item.email === userEmail).id;
  const link = await post(`/admin/users/${userId}/devices`, { device_id: deviceId }, adminToken);
  assert.equal(link.status, 201);

  const inaccessible = await fetch(`${base}/devices/${encodeURIComponent(deviceId)}`, {
    headers: { Authorization: `Bearer ${otherToken}` }
  });
  assert.equal(inaccessible.status, 404);
  const visibleDevices = await fetch(`${base}/devices`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.equal((await visibleDevices.json()).devices.length, 1);

  const deviceHeaders = { 'X-Device-Id': deviceId, 'X-Device-Key': deviceKey };
  const noKey = await fetch(`${base}/device/ping`);
  assert.equal(noKey.status, 401);
  const wrongKey = await fetch(`${base}/device/ping`, {
    headers: { 'X-Device-Id': deviceId, 'X-Device-Key': 'not-the-device-key' }
  });
  assert.equal(wrongKey.status, 401);

  await waitForDeviceLimit();
  const postReading = await fetch(`${base}/device/telemetry`, {
    method: 'POST',
    headers: { ...deviceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ temp: 23.1, hum: 55 })
  });
  assert.equal(postReading.status, 201);
  await waitForDeviceLimit();
  const latest = await fetch(`${base}/devices/${deviceId}/telemetry/latest`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.equal((await latest.json()).reading.payload.temp, 23.1);

  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const ingestionUrl = `${base}/device/ingest?temp=24.2&hum=56&ts=${ts}&nonce=${nonce}`;
  await waitForDeviceLimit();
  const accepted = await fetch(ingestionUrl, { headers: deviceHeaders });
  assert.equal(accepted.status, 200);
  await waitForDeviceLimit();
  const replay = await fetch(ingestionUrl, { headers: deviceHeaders });
  assert.equal(replay.status, 409);
  await waitForDeviceLimit();
  const unknownQuery = await fetch(`${base}/device/ingest?temp=22&unknown=1`, { headers: deviceHeaders });
  assert.equal(unknownQuery.status, 400);
  await waitForDeviceLimit();
  const outOfRange = await fetch(`${base}/device/ingest?temp=126&ts=${Math.floor(Date.now() / 1000)}&nonce=${crypto.randomBytes(16).toString('hex')}`, {
    headers: deviceHeaders
  });
  assert.equal(outOfRange.status, 400);

  const history = await fetch(`${base}/devices/${deviceId}/telemetry?limit=10&page=1`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.equal((await history.json()).total, 2);
});
