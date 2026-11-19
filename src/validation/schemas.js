'use strict';

const { z } = require('zod');

const numeric = (min, max) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
  z.number().finite().min(min).max(max)
);

const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const password = z.string().min(12).max(72).refine(
  (value) => Buffer.byteLength(value, 'utf8') <= 72
);
const loginPassword = z.string().min(1).max(72).refine(
  (value) => Buffer.byteLength(value, 'utf8') <= 72
);
const deviceId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const telemetry = {
  temp: numeric(-40, 125).optional(),
  hum: numeric(0, 100).optional(),
  bat: numeric(0, 100).optional(),
  press: numeric(0, 200000).optional(),
  lux: numeric(0, 200000).optional(),
  rssi: numeric(-150, 0).optional()
};

const telemetrySchema = z.object(telemetry).strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one measurement is required.' }
);

const getTelemetrySchema = z.object({
  ...telemetry,
  ts: z.preprocess((value) => typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
    z.number().int().positive().optional()),
  nonce: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional()
}).strict().refine(
  (value) => Object.keys(value).some((key) => key in telemetry),
  { message: 'At least one measurement is required.' }
);

const pageQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.preprocess((value) => value === undefined ? 50 : Number(value), z.number().int().min(1).max(200)),
  page: z.preprocess((value) => value === undefined ? 1 : Number(value), z.number().int().min(1).max(10000))
}).strict().refine(
  (value) => !value.from || !value.to || value.from <= value.to,
  { message: 'Invalid date range.' }
);

const idParams = z.object({ id: deviceId }).strict();
const commandIdParams = z.object({ commandId: z.coerce.number().int().positive() }).strict();

module.exports = {
  adminUserCreate: z.object({ email, password }).strict(),
  adminUserUpdate: z.object({
    email: email.optional(),
    password: password.optional(),
    status: z.enum(['active', 'inactive']).optional()
  }).strict().refine((value) => Object.keys(value).length > 0),
  commandIdParams,
  deviceCreate: z.object({
    device_id: deviceId,
    name: z.string().trim().min(1).max(120),
    user_id: z.coerce.number().int().positive().optional(),
    allow_get: z.boolean().optional(),
    require_nonce: z.boolean().optional(),
    interval_sec: z.number().int().min(1).max(3600).optional()
  }).strict(),
  deviceUpdate: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    allow_get: z.boolean().optional(),
    require_nonce: z.boolean().optional(),
    interval_sec: z.number().int().min(1).max(3600).optional()
  }).strict().refine((value) => Object.keys(value).length > 0),
  email,
  getTelemetrySchema,
  idParams,
  login: z.object({ email, password: loginPassword }).strict(),
  pageQuery,
  password,
  register: z.object({ email, password }).strict(),
  telemetrySchema,
  userDeviceParams: z.object({ userId: z.coerce.number().int().positive(), deviceId }).strict(),
  userIdParams: z.object({ userId: z.coerce.number().int().positive() }).strict(),
  userDeviceLink: z.object({ device_id: deviceId }).strict(),
  commandCreate: z.object({ command: z.string().trim().min(1).max(255) }).strict(),
  ackQuery: z.object({
    id: z.coerce.number().int().positive(),
    status: z.literal('done')
  }).strict(),
  auditQuery: z.object({
    limit: z.preprocess((value) => value === undefined ? 100 : Number(value), z.number().int().min(1).max(200))
  }).strict(),
  ackBody: z.object({ status: z.literal('done') }).strict()
};
