'use strict';

const { HttpError } = require('../lib/errors');

function validateQueryPolicy(allowedPaths = []) {
  return (req, res, next) => {
    const queryIndex = req.originalUrl.indexOf('?');
    if (queryIndex < 0) return next();
    const query = req.originalUrl.slice(queryIndex + 1);
    const count = query === '' ? 0 : query.split('&').length;
    const requestPath = new URL(req.originalUrl, 'http://localhost').pathname.replace(/^\/api\/v1/, '') || '/';
    const pathAllowed = allowedPaths.some((path) => path instanceof RegExp ? path.test(requestPath) : path === requestPath);
    if (Buffer.byteLength(req.originalUrl, 'utf8') > 1024 || count > 20 || !pathAllowed) {
      return next(new HttpError(400, 'Invalid request.'));
    }
    next();
  };
}

function validate(schemas) {
  return (req, res, next) => {
    const validated = {};
    for (const part of ['body', 'query', 'params']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part]);
      if (!result.success) return next(new HttpError(400, 'Invalid request.'));
      validated[part] = result.data;
    }
    req.validated = validated;
    next();
  };
}

module.exports = { validate, validateQueryPolicy };
