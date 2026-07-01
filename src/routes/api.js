'use strict';

/**
 * Public dashboard API — powers the friendly web UI (no admin key needed).
 * The protected /admin/* API still exists for programmatic/staff access.
 */

const express = require('express');
const firestore = require('../services/firestore');
const conversation = require('../services/conversation');
const { summary } = require('../config');

const router = express.Router();

// Everything the dashboard needs in one call.
router.get('/summary', async (_req, res, next) => {
  try {
    const [bookings, sessions] = await Promise.all([
      firestore.listBookings({}),
      firestore.listSessions({}),
    ]);
    res.json({
      health: summary(),
      bookings,
      sessions: sessions.map((s) => ({
        callId: s.callId, stage: s.stage, patientName: s.patientName,
        service: s.service, dateTime: s.dateTime, confirmed: s.confirmed,
        turns: (s.stateHistory || []).length, updatedAt: s.updatedAt,
      })),
    });
  } catch (err) { next(err); }
});

// Book an appointment from the form. Runs the same conversation flow the
// voice agent uses, so calendar + SMS + logging all happen identically.
router.post('/book', async (req, res, next) => {
  try {
    const { name, service, when, phone } = req.body || {};
    if (!name || !service || !when) {
      return res.status(400).json({ ok: false, error: 'Please provide a name, service and date/time.' });
    }
    const callId = 'ui-' + Date.now();
    const ph = phone || '+15005550006';
    await conversation.handleTurn({ callId, userInput: 'my name is ' + name, phone: ph });
    await conversation.handleTurn({ callId, userInput: String(service), phone: ph });
    await conversation.handleTurn({ callId, userInput: String(when), phone: ph });
    const r = await conversation.handleTurn({ callId, userInput: 'yes', phone: ph });
    if (!r.booking) return res.status(422).json({ ok: false, error: 'Could not complete the booking. Check the date/time.' });
    res.json({ ok: true, stage: r.stage, booking: r.booking });
  } catch (err) { next(err); }
});

module.exports = router;
