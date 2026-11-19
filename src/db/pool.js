'use strict';

const mysql = require('mysql2/promise');

function createPool(overrides = {}) {
  const options = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 5,
    idleTimeout: 60000,
    queueLimit: 0,
    timezone: 'Z',
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    ...overrides
  };
  for (const field of ['host', 'user', 'database']) {
    if (!options[field]) throw new Error(`Missing database configuration: ${field}`);
  }
  const pool = mysql.createPool(options);
  pool.on('connection', (connection) => {
    connection.on('error', () => {
      console.error('A MySQL connection error occurred; the pool will replace the connection.');
    });
  });
  return pool;
}

module.exports = { createPool };
