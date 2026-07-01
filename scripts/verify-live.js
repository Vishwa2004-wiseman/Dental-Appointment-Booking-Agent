'use strict';
/**
 * Verify-live: drive one real booking using your .env credentials (no mock
 * override). Creates a real Google Calendar event and, if Twilio is configured,
 * sends a real SMS. Run from the repo root:  node scripts/verify-live.js
 */
const { summary } = require('../src/config');
const firestore = require('../src/services/firestore');
const calendar = require('../src/services/calendar');
const sms = require('../src/services/sms');
const conversation = require('../src/services/conversation');

(async () => {
  console.log('Integration status:', summary());
  firestore.init();
  calendar.init();
  sms.init();

  const callId = 'verify-' + Date.now();
  const phone = process.env.VERIFY_PHONE || '+15551234567';
  await conversation.handleTurn({ callId, userInput: 'my name is Test Patient', phone });
  await conversation.handleTurn({ callId, userInput: 'a cleaning', phone });
  await conversation.handleTurn({ callId, userInput: 'tomorrow at 2pm', phone });
  const r = await conversation.handleTurn({ callId, userInput: 'yes', phone });

  console.log('\n=== RESULT ===');
  console.log('stage        :', r.stage);
  console.log('calendar id  :', r.booking && r.booking.googleEventId);
  console.log('calendar link:', (r.booking && r.booking.calendarLink) || '(none)');
  console.log('twilio sid   :', r.booking && r.booking.twilioSid);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
