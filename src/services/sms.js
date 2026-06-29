'use strict';

/**
 * Twilio SMS integration — sends a confirmation text when a booking completes.
 * Mock mode logs the message instead of sending it.
 */

const { config } = require('../config');
const { formatWhen } = require('../state/flow');

let client = null;

function init() {
  if (config.mockMode || !config.hasTwilio) {
    console.log('[sms] running in MOCK mode (messages logged, not sent)');
    return;
  }
  const twilio = require('twilio');
  client = twilio(config.twilio.accountSid, config.twilio.authToken);
  console.log('[sms] connected, from =', config.twilio.fromNumber);
}

function buildConfirmation({ patientName, service, dateTime }) {
  return `Hi ${patientName}, your ${service} is confirmed for ${formatWhen(dateTime)}. ` +
    `Reply here if you need to reschedule. — Your dental clinic`;
}

/**
 * @returns {Promise<{ sid: string, mock: boolean }>}
 */
async function sendConfirmation({ to, patientName, service, dateTime }) {
  const body = buildConfirmation({ patientName, service, dateTime });

  if (!client) {
    console.log(`[sms:mock] → ${to || '(no number)'}: ${body}`);
    return { sid: `mock-sms-${Date.now()}`, mock: true };
  }
  if (!to) {
    console.warn('[sms] no destination number on session; skipping send');
    return { sid: null, mock: false, skipped: true };
  }

  const msg = await client.messages.create({
    body,
    from: config.twilio.fromNumber,
    to,
  });
  return { sid: msg.sid, mock: false };
}

module.exports = { init, buildConfirmation, sendConfirmation };
