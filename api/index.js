'use strict';

/**
 * Vercel serverless entry point.
 *
 * An Express app is itself a (req, res) handler, so we initialise the
 * integration services once (cold start) and export the app. `vercel.json`
 * routes every path here.
 */

const { createApp, initServices } = require('../src/index');

initServices();
const app = createApp();

module.exports = app;
