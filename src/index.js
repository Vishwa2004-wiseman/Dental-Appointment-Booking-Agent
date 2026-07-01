'use strict';

/**
 * Express application entry point.
 *
 * Wires up middleware, initialises the integration services (Firestore,
 * Calendar, Twilio — each no-ops gracefully in mock mode), and mounts routes.
 */

const express = require('express');
const path = require('path');
const { config, summary } = require('./config');

const firestore = require('./services/firestore');
const calendar = require('./services/calendar');
const sms = require('./services/sms');

const webhookRouter = require('./routes/webhook');
const adminRouter = require('./routes/admin');
const apiRouter = require('./routes/api');
const { notFound, errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.use(express.json({ limit: '2mb' }));
  app.disable('x-powered-by');

  // Lightweight request log.
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.originalUrl}`);
    next();
  });

  // Health check — used by Railway and the evaluator.
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'dental-booking-agent',
      time: new Date().toISOString(),
      ...summary(),
    });
  });

  // Serve the admin dashboard (attractive web UI) at the root.
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use('/webhooks', webhookRouter);
  app.use('/admin', adminRouter);
  app.use('/api', apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

function initServices() {
  firestore.init();
  calendar.init();
  sms.init();
}

function start() {
  initServices();
  const app = createApp();
  app.listen(config.port, () => {
    console.log('─'.repeat(52));
    console.log('  Dental Booking Agent listening on :' + config.port);
    console.table(summary());
    console.log('─'.repeat(52));
  });
  return app;
}

// Start only when run directly (so tests/simulate can import createApp).
if (require.main === module) {
  start();
}

module.exports = { createApp, initServices, start };
