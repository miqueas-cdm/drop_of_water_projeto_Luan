'use strict';

const bcrypt = require('bcryptjs');
const schemas = require('../validation/schemas');

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin','user') NOT NULL DEFAULT 'user',
    status ENUM('active','inactive') NOT NULL DEFAULT 'active',
    failed_login_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    locked_until DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS devices (
    device_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('active','inactive') NOT NULL DEFAULT 'active',
    allow_get TINYINT(1) NOT NULL DEFAULT 1,
    require_nonce TINYINT(1) NOT NULL DEFAULT 1,
    interval_sec SMALLINT UNSIGNED NOT NULL DEFAULT 60,
    last_seen_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_devices_status_seen (status, last_seen_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS user_devices (
    user_id BIGINT UNSIGNED NOT NULL,
    device_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, device_id),
    CONSTRAINT fk_user_devices_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_devices_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS telemetry (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_telemetry_device_created (device_id, created_at),
    INDEX idx_telemetry_created (created_at),
    CONSTRAINT fk_telemetry_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS commands (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    command VARCHAR(255) NOT NULL,
    status ENUM('pending','sent','acked') NOT NULL DEFAULT 'pending',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME NULL,
    acked_at DATETIME NULL,
    INDEX idx_commands_device_status (device_id, status, id),
    CONSTRAINT fk_commands_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS used_nonces (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    nonce VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_nonce_device_nonce (device_id, nonce),
    INDEX idx_nonces_expiry (expires_at),
    CONSTRAINT fk_nonces_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    actor_user_id BIGINT UNSIGNED NULL,
    action VARCHAR(80) NOT NULL,
    target_type VARCHAR(40) NOT NULL,
    target_id VARCHAR(100) NULL,
    details JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_created (created_at),
    CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`
];

async function initializeDatabase(pool) {
  for (const statement of schemaStatements) {
    await pool.query(statement);
  }

  const parsedEmail = schemas.email.safeParse(process.env.ADMIN_EMAIL);
  const email = parsedEmail.success ? parsedEmail.data : '';
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('A valid ADMIN_EMAIL and ADMIN_PASSWORD must be configured.');
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('ADMIN_PASSWORD must contain at least 12 characters and at most 72 UTF-8 bytes.');
  }

  const [existing] = await pool.execute(
    'SELECT id, role, status FROM users WHERE email = ? LIMIT 1',
    [email.toLowerCase()]
  );
  if (existing.length === 0) {
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.execute(
      'INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
      [email.toLowerCase(), passwordHash, 'admin']
    );
  } else if (existing[0].role !== 'admin' || existing[0].status !== 'active') {
    throw new Error('ADMIN_EMAIL must identify an active administrator account.');
  }
}

module.exports = { initializeDatabase, schemaStatements };
