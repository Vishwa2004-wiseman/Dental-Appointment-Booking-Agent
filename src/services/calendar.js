'use strict';

/**
 * Google Calendar integration.
 *
 * One service account books into a per-clinic calendar (GOOGLE_CALENDAR_ID).
 * In mock mode we return a fake event id so the rest of the flow (and the
 * simulate script) works without any Google setup.
 */

const { config } = require('../config');

let calendarClient = null;

function init() {
  if (config.mockMode || !config.hasGoogle) {
    console.log('[calendar] running in MOCK mode (no events created)');
    return;
  }
  const { google } = require('googleapis');

  let credentials;
  if (config.google.serviceAccountJson) {
    credentials = JSON.parse(config.google.serviceAccountJson);
  } else {
    // Reuse the Firebase service account for Calendar as well.
    credentials = {
      client_email: config.firebase.clientEmail,
      private_key: config.firebase.privateKey,
    };
  }

  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/calendar']
  );

  calendarClient = google.calendar({ version: 'v3', auth });
  console.log('[calendar] connected, calendarId =', config.google.calendarId);
}

/**
 * Create an appointment event.
 *
 * @returns {Promise<{ eventId: string, htmlLink: string|null, start: string, end: string, mock: boolean }>}
 */
async function createEvent({ patientName, service, startTimeIso, phone }) {
  const start = new Date(startTimeIso);
  const end = new Date(start.getTime() + config.google.appointmentDurationMinutes * 60 * 1000);

  const summary = `${service} — ${patientName}`;
  const description = [
    `Patient: ${patientName}`,
    phone ? `Phone: ${phone}` : null,
    `Service: ${service}`,
    `Booked by AI dental receptionist (VAPI).`,
  ].filter(Boolean).join('\n');

  if (!calendarClient) {
    return {
      eventId: `mock-evt-${Date.now()}`,
      htmlLink: null,
      start: start.toISOString(),
      end: end.toISOString(),
      mock: true,
    };
  }

  const res = await calendarClient.events.insert({
    calendarId: config.google.calendarId,
    requestBody: {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone: config.google.timezone },
      end: { dateTime: end.toISOString(), timeZone: config.google.timezone },
    },
  });

  return {
    eventId: res.data.id,
    htmlLink: res.data.htmlLink || null,
    start: start.toISOString(),
    end: end.toISOString(),
    mock: false,
  };
}

module.exports = { init, createEvent };
