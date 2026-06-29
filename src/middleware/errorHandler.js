'use strict';

/**
 * Express error + 404 handling.
 *
 * Important for VAPI: the webhook route catches its own errors and still
 * returns HTTP 200 (see routes/webhook.js). This global handler is the safety
 * net for everything else.
 */

function notFound(req, res, next) {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  console.error(`[error] ${req.method} ${req.originalUrl} →`, err.stack || err.message);
  res.status(status).json({
    error: err.code || 'internal_error',
    message: err.message || 'Something went wrong.',
  });
}

module.exports = { notFound, errorHandler };
