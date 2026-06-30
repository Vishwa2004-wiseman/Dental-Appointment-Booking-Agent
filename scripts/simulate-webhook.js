'use strict';

/**
 * Local end-to-end simulation — no VAPI, no cloud needed.
 *
 * Boots the Express app in-process (mock mode auto-engages without creds),
 * then fires a sequence of VAPI-shaped `conversation-update` webhooks that
 * walk a full booking: name → service → date/time → confirm.
 *
 * Finally it hits the admin API to prove the booking + session were persisted.
 *
 * Run:  npm run simulate
 */

const http = require('http');
const { createApp, initServices } = require('../src/index');
const { config } = require('../src/config');

const CALL_ID = `sim-call-${Date.now()}`;
const PHONE = '+15551234567';
const ADMIN_KEY = config.admin.apiKey || 'change-me-please';

function conversationUpdate(text) {
  return {
    message: {
      type: 'conversation-update',
      call: { id: CALL_ID, customer: { number: PHONE } },
      messages: [{ role: 'user', message: text }],
    },
  };
}

function post(server, path, body, headers = {}) {
  return request(server, 'POST', path, body, headers);
}
function get(server, path, headers = {}) {
  return request(server, 'GET', path, null, headers);
}

function request(server, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: {
        'content-type': 'application/json',
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function line(label, value) {
  console.log(`  ${label.padEnd(14)} ${value}`);
}

async function main() {
  console.log('\n🦷  Dental Booking Agent — end-to-end simulation\n');

  initServices();
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));

  // 0) Health check
  const health = await get(server, '/health');
  console.log('▶ Health check');
  line('status', health.body.status);
  line('firestore', health.body.firestore);
  line('calendar', health.body.calendar);
  line('sms', health.body.sms);
  console.log();

  // 1) Walk the conversation
  const turns = [
    'Hi, my name is Priya Sharma',
    "I'd like to book a cleaning",
    'tomorrow at 3pm please',
    'yes that sounds good',
  ];

  console.log('▶ Conversation');
  for (const t of turns) {
    const r = await post(server, '/webhooks/vapi', conversationUpdate(t));
    console.log(`  👤 ${t}`);
    console.log(`  🤖 [${r.body.stage}] ${r.body.reply}\n`);
  }

  // 2) Verify session persisted with full state history
  const sessionRes = await get(server, `/admin/sessions/${CALL_ID}`, { 'x-admin-key': ADMIN_KEY });
  const session = sessionRes.body.session;
  console.log('▶ Session in store');
  line('callId', session.callId);
  line('stage', session.stage);
  line('patient', session.patientName);
  line('service', session.service);
  line('dateTime', session.dateTime);
  line('confirmed', session.confirmed);
  line('history', `${session.stateHistory.length} transitions`);
  line('bookingId', session.bookingId || '(none)');
  console.log();

  // 3) Verify booking created (calendar + sms fired)
  const bookingsRes = await get(server, '/admin/bookings', { 'x-admin-key': ADMIN_KEY });
  console.log('▶ Bookings');
  line('count', bookingsRes.body.count);
  const b = bookingsRes.body.bookings[0];
  if (b) {
    line('patient', b.patientName);
    line('service', b.service);
    line('start', b.startTime);
    line('calendarId', b.googleEventId);
    line('twilioSid', b.twilioSid);
    line('status', b.status);
  }
  console.log();

  // 4) Assertions
  const checks = [
    ['health ok', health.body.status === 'ok'],
    ['session resumed same callId', session.callId === CALL_ID],
    ['reached COMPLETED', session.stage === 'COMPLETED'],
    ['name captured', session.patientName === 'Priya Sharma'],
    ['service captured', session.service === 'cleaning'],
    ['datetime captured', Boolean(session.dateTime)],
    ['booking created', bookingsRes.body.count >= 1],
    ['calendar event id present', Boolean(b && b.googleEventId)],
    ['sms sid present', Boolean(b && b.twilioSid)],
    ['state history recorded', session.stateHistory.length >= 4],
  ];

  console.log('▶ Checks');
  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${name}`);
    if (!pass) failed++;
  }
  console.log();

  server.close();

  if (failed) {
    console.error(`❌ ${failed} check(s) failed\n`);
    process.exit(1);
  }
  console.log('✅ All checks passed — full booking flow works end-to-end.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Simulation crashed:', err);
  process.exit(1);
});
