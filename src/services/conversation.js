'use strict';

/**
 * Conversation orchestrator.
 *
 * Ties the pure state machine (state/flow.js) to persistence (firestore.js)
 * and fulfilment (calendar.js + sms.js). This is the single place that knows
 * "when a booking is confirmed, create the calendar event and text the patient."
 */

const { v4: uuidv4 } = require('uuid');
const flow = require('../state/flow');
const firestore = require('./firestore');
const calendar = require('./calendar');
const sms = require('./sms');
const { config } = require('../config');

/**
 * Handle one user turn for a given call.
 *
 * @param {object} params
 * @param {string} params.callId
 * @param {string} params.userInput  free-text from the caller
 * @param {string} [params.phone]
 * @param {string} [params.clinicId]
 * @returns {Promise<{ reply: string, stage: string, session: object, booking?: object }>}
 */
async function handleTurn({ callId, userInput, phone, clinicId }) {
  if (!callId) throw new Error('handleTurn requires a callId');

  const session = await firestore.ensureSession(callId, {
    clinicId: clinicId || config.clinicId,
    phone,
  });

  // Already finished? Don't advance again — just replay the closing line.
  if (flow.isTerminal(session.stage)) {
    return { reply: flow.promptFor(session.stage, session), stage: session.stage, session };
  }

  const { nextStage, updates, reply } = flow.advance(session, userInput);

  const saved = await firestore.saveTurn(callId, {
    updates,
    stage: nextStage,
    userInput,
    agentReply: reply,
  });

  let booking;
  if (nextStage === flow.STAGES.COMPLETED && !saved.bookingId) {
    booking = await fulfilBooking(saved);
  }

  return { reply, stage: nextStage, session: saved, booking };
}

/**
 * Create the calendar event + send SMS + write the booking doc.
 * Isolated so a failure here can be retried without re-running the whole flow.
 */
async function fulfilBooking(session) {
  const bookingId = uuidv4();

  const event = await calendar.createEvent({
    patientName: session.patientName,
    service: session.service,
    startTimeIso: session.dateTime,
    phone: session.phone,
  });

  const text = await sms.sendConfirmation({
    to: session.phone,
    patientName: session.patientName,
    service: session.service,
    dateTime: session.dateTime,
  });

  const booking = await firestore.createBooking({
    bookingId,
    callId: session.callId,
    clinicId: session.clinicId,
    patientName: session.patientName,
    service: session.service,
    startTime: event.start,
    endTime: event.end,
    googleEventId: event.eventId,
    calendarLink: event.htmlLink,
    twilioSid: text.sid,
    status: 'confirmed',
  });

  // Link the booking back onto the session for easy lookup.
  await firestore.saveTurn(session.callId, {
    updates: { bookingId, confirmed: true },
    stage: flow.STAGES.COMPLETED,
    userInput: null,
    agentReply: null,
  });

  console.log(`[conversation] booking ${bookingId} created (event=${event.eventId}, sms=${text.sid})`);
  return booking;
}

/**
 * Directly apply structured slot values coming from VAPI tool-calls, rather
 * than parsing free text. Used by the tool-call branch of the webhook.
 */
async function applyToolCall({ callId, tool, args, phone, clinicId }) {
  const session = await firestore.ensureSession(callId, {
    clinicId: clinicId || config.clinicId,
    phone,
  });

  const updates = {};
  let nextStage = session.stage;
  let reply = '';

  switch (tool) {
    case 'collect_patient_info':
      updates.patientName = args.name || session.patientName;
      if (args.phone) updates.phone = args.phone;
      nextStage = flow.STAGES.AWAITING_SERVICE;
      reply = `Thanks ${updates.patientName}. What service would you like?`;
      break;
    case 'select_service':
      updates.service = args.service;
      nextStage = flow.STAGES.AWAITING_DATETIME;
      reply = 'Got it. What day and time works for you?';
      break;
    case 'select_datetime':
      updates.dateTime = flow.extractDateTime(args.dateTime) || args.dateTime;
      nextStage = flow.STAGES.AWAITING_CONFIRMATION;
      reply = `To confirm: a ${session.service || updates.service} on ${flow.formatWhen(updates.dateTime)}. Shall I book it?`;
      break;
    case 'confirm_booking':
      updates.confirmed = true;
      nextStage = flow.STAGES.COMPLETED;
      reply = "You're booked! A confirmation text is on its way.";
      break;
    default:
      reply = 'Sorry, I did not understand that request.';
  }

  const saved = await firestore.saveTurn(callId, { updates, stage: nextStage, userInput: `[tool:${tool}]`, agentReply: reply });

  let booking;
  if (nextStage === flow.STAGES.COMPLETED && !saved.bookingId) {
    booking = await fulfilBooking(saved);
  }

  return { reply, stage: nextStage, session: saved, booking };
}

module.exports = { handleTurn, applyToolCall, fulfilBooking };
