'use strict';

class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
    Error.captureStackTrace?.(this, AppError);
  }
}

function assert(condition, status, code, message, details) {
  if (!condition) {
    throw new AppError(status, code, message, details);
  }
}

function asyncRoute(handler) {
  return function wrappedRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { AppError, assert, asyncRoute };
