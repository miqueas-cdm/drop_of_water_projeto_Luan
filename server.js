'use strict';

require('dotenv').config();

const appFactory = require('./src/app');
const { createPool } = require('./src/db/pool');
const { initializeDatabase } = require('./src/db/schema');

async function start() {
  let pool;
  try {
    if (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET) < 32) {
      throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
    }
    pool = createPool();
    const app = appFactory({ pool });
    const port = Number(process.env.PORT) || 3000;
    const server = app.listen(port, '0.0.0.0', () => {
      console.info(`Drop of Water API listening on port ${port}`);
    });
    server.once('error', () => {
      console.error('Unable to start the HTTP server. Check the configured port.');
      pool.end().catch(() => {});
      process.exitCode = 1;
    });

    const shutdown = () => {
      server.close(() => {
        pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
      });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

    initializeDatabase(pool).catch((error) => {
      console.error('Database initialization failed.', error && error.code ? error.code : '');
    });

    return server;
  } catch {
    if (pool) await pool.end().catch(() => {});
    console.error('Server startup failed. Check JWT_SECRET and database environment variables.');
    process.exitCode = 1;
    return null;
  }
}

start();

module.exports = { start };
