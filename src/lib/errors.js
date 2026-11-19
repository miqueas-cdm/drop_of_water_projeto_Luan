'use strict';

class HttpError extends Error {
  constructor(status, message = 'Request could not be completed.') {
    super(message);
    this.status = status;
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { HttpError, asyncRoute };
