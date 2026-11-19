'use strict';

const path = require('node:path');
const cors = require('cors');
const express = require('express');
const { ipKeyGenerator, rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const { createAuthRouter } = require('./routes/auth');
const { createDeviceRouter } = require('./routes/devices');
const { createUsersRouter } = require('./routes/users');
const { createAdminRouter } = require('./routes/admin');
const { HttpError } = require('./lib/errors');
const { validateQueryPolicy } = require('./middleware/validate');

function createApp({ pool, allowedOrigins } = {}) {
  if (!pool) throw new Error('A MySQL pool is required.');
  if (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET) < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
  }
  const origins = allowedOrigins || String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    if (req.originalUrl.includes('?')) {
      const queryIndex = req.originalUrl.indexOf('?');
      const rawQuery = req.originalUrl.slice(queryIndex + 1);
      if (Buffer.byteLength(req.originalUrl, 'utf8') > 1024 ||
          (rawQuery !== '' && rawQuery.split('&').length > 20)) {
        return next(new HttpError(400, 'Invalid request.'));
      }
      const requestUrl = new URL(req.originalUrl, 'http://localhost');
      const hasCredentialQuery = [...requestUrl.searchParams.keys()].some((name) =>
        ['key', 'devicekey', 'xdevicekey', 'apikey', 'deviceapikey', 'token', 'accesstoken', 'refreshtoken', 'secret']
          .includes(name.replace(/[-_]/g, '').toLowerCase())
      );
      if (hasCredentialQuery) return next(new HttpError(400, 'Invalid request.'));
    }
    if (req.get('x-forwarded-proto') === 'http') {
      let host;
      try {
        host = new URL(`https://${req.get('host')}`);
      } catch {
        return next(new HttpError(400, 'Invalid request.'));
      }
      const allowedHosts = new Set(origins.map((origin) => {
        try {
          return new URL(origin).host.toLowerCase();
        } catch {
          return '';
        }
      }));
      if (process.env.NODE_ENV !== 'production' || allowedHosts.has(host.host.toLowerCase())) {
        return res.redirect(308, `https://${host.host}${req.originalUrl}`);
      }
      return next(new HttpError(400, 'Invalid request.'));
    }
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'connect-src': ["'self'", 'https:'],
        'upgrade-insecure-requests': process.env.NODE_ENV === 'production' ? [] : null
      }
    }
  }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || origins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-Device-Key'],
    maxAge: 600
  }));
  app.use(express.json({ limit: '10kb', strict: true, type: 'application/json' }));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      console.info(JSON.stringify({
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        duration_ms: Date.now() - started
      }));
    });
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again later.' }
  });
  const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Try again later.' }
  });
  const deviceLimiter = rateLimit({
    windowMs: 1000,
    limit: 1,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator(req) {
      const deviceId = req.get('X-Device-Id');
      return deviceId ? `device:${deviceId}` : ipKeyGenerator(req.ip);
    },
    message: { error: 'Too many device requests. Try again shortly.' }
  });

  const api = express.Router();
  api.get('/health', validateQueryPolicy([]), async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.set('Cache-Control', 'no-store').json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).set('Cache-Control', 'no-store').json({ status: 'error', db: 'unavailable' });
    }
  });
  api.use('/', createAuthRouter(pool, loginLimiter));
  api.use('/device', createDeviceRouter(pool, deviceLimiter));
  api.use('/', createUsersRouter(pool, readLimiter));
  api.use('/admin', createAdminRouter(pool));
  app.use('/api/v1', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, api);
  app.get('/health', validateQueryPolicy([]), async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.set('Cache-Control', 'no-store').json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).set('Cache-Control', 'no-store').json({ status: 'error', db: 'unavailable' });
    }
  });

  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/admin', express.static(path.join(publicDir, 'admin'), { index: 'index.html', fallthrough: false }));
  app.use('/tester', express.static(path.join(publicDir, 'tester'), { index: 'index.html', fallthrough: false }));
  app.use('/app-demo', express.static(path.join(publicDir, 'app-demo'), { index: 'index.html', fallthrough: false }));
  app.get('/', (req, res) => res.redirect('/admin/'));

  app.use((req, res, next) => next(new HttpError(404, 'Not found.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) ? error.status : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    if (status >= 500) {
      console.error(JSON.stringify({ event: 'request_error', code: error.code || 'INTERNAL_ERROR' }));
    }
    res.status(status).json({
      error: status === 413 ? 'Request too large.' :
        status === 400 ? 'Invalid request.' :
          status === 401 ? 'Authentication required.' :
            status === 403 ? 'Access denied.' :
              status === 404 ? 'Not found.' :
                status === 409 ? error.message :
                  status === 429 ? 'Too many requests. Try again later.' :
                    'Request could not be completed.'
    });
  });

  return app;
}

module.exports = createApp;
