'use strict';

/**
 * Admin REST API — read-only views over bookings and sessions.
 * Protected by a simple `X-Admin-Key` header matching ADMIN_API_KEY.
 * (Documented corner cut: no OAuth admin panel for the 48h build.)
 */

const express = require('express');
const firestore = require('../services/firestore');
const conversation = require('../services/conversation');
const { config } = require('../config');

const router = express.Router();

// Simple API-key gate applied to every /admin route.
router.use((req, res, next) => {
  if (!config.admin.apiKey) {
    // No key configured → refuse rather than silently exposing data.
    return res.status(503).json({ error: 'admin_disabled', message: 'Set ADMIN_API_KEY to enable admin endpoints.' });
  }
  const provided = req.get('x-admin-key');
  if (provided !== config.admin.apiKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// GET /admin/bookings — list confirmed bookings for the clinic.
router.get('/bookings', async (req, res, next) => {
  try {
    const clinicId = req.query.clinicId || config.clinicId;
    const bookings = await firestore.listBookings({ clinicId });
    res.json({ clinicId, count: bookings.length, bookings });
  } catch (err) { next(err); }
});

// GET /admin/sessions — list all sessions (most recent first).
router.get('/sessions', async (req, res, next) => {
  try {
    const clinicId = req.query.clinicId || config.clinicId;
    const sessions = await firestore.listSessions({ clinicId });
    // Trim heavy fields for the list view.
    const summary = sessions.map((s) => ({
      callId: s.callId,
      clinicId: s.clinicId,
      stage: s.stage,
      patientName: s.patientName,
      service: s.service,
      dateTime: s.dateTime,
      confirmed: s.confirmed,
      turns: (s.stateHistory || []).length,
      updatedAt: s.updatedAt,
    }));
    res.json({ clinicId, count: summary.length, sessions: summary });
  } catch (err) { next(err); }
});

// GET /admin/sessions/:callId — full detail incl. state history + transcript.
router.get('/sessions/:callId', async (req, res, next) => {
  try {
    const session = await firestore.getSession(req.params.callId);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    res.json({ session });
  } catch (err) { next(err); }
});

// POST /admin/demo-booking — create a sample booking end-to-end (calendar + SMS).
// Handy for the dashboard button and live demos.
router.post('/demo-booking', async (req, res, next) => {
  try {
    const names = ['Priya Sharma', 'Alex Rivera', 'Sam Lee', 'Maria Gomez', 'John Carter', 'Aisha Khan'];
    const services = ['cleaning', 'checkup', 'filling', 'whitening'];
    const name = names[Math.floor(Math.random() * names.length)];
    const service = services[Math.floor(Math.random() * services.length)];
    const phone = (req.body && req.body.phone) || '+15005550006';
    const callId = 'demo-' + Date.now();
    await conversation.handleTurn({ callId, userInput: 'my name is ' + name, phone });
    await conversation.handleTurn({ callId, userInput: service, phone });
    await conversation.handleTurn({ callId, userInput: 'tomorrow at 2pm', phone });
    const r = await conversation.handleTurn({ callId, userInput: 'yes', phone });
    res.json({ ok: true, stage: r.stage, booking: r.booking });
  } catch (err) { next(err); }
});

module.exports = router;
