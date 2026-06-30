'use strict';

/**
 * Zero-dependency logic tests for the conversation state machine and the
 * in-process orchestrator (mock mode). Runs anywhere Node runs — no npm install,
 * no cloud credentials. Great as a fast pre-commit check.
 *
 * Run:  node scripts/test-flow.js
 */

const assert = require('assert');
const flow = require('../src/state/flow');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, `FAILED: ${name}`);
  console.log(`  ✅ ${name}`);
  passed++;
}

async function run() {
  console.log('\n▶ State machine — slot extraction');
  ok('extractName strips lead-in', flow.extractName('my name is John Doe') === 'John Doe');
  ok('extractName title-cases', flow.extractName('priya sharma') === 'Priya Sharma');
  ok('extractService finds cleaning', flow.extractService('I want a cleaning') === 'cleaning');
  ok('extractService longest-match root canal', flow.extractService('need a root canal') === 'root canal');
  ok('extractService pain → emergency', flow.extractService('my tooth hurts badly') === 'emergency');
  ok('extractDateTime parses tomorrow 3pm', /T/.test(flow.extractDateTime('tomorrow at 3pm') || ''));
  ok('isAffirmative yes', flow.isAffirmative('yes please') === true);
  ok('isNegative no', flow.isNegative('no thanks') === true);

  console.log('\n▶ State machine — transitions');
  let s = { stage: flow.STAGES.AWAITING_NAME };
  let r = flow.advance(s, 'my name is Priya Sharma');
  ok('name → AWAITING_SERVICE', r.nextStage === flow.STAGES.AWAITING_SERVICE);
  ok('name captured', r.updates.patientName === 'Priya Sharma');

  s = { stage: flow.STAGES.AWAITING_SERVICE, patientName: 'Priya Sharma' };
  r = flow.advance(s, 'a cleaning');
  ok('service → AWAITING_DATETIME', r.nextStage === flow.STAGES.AWAITING_DATETIME);

  s = { stage: flow.STAGES.AWAITING_DATETIME, patientName: 'Priya Sharma', service: 'cleaning' };
  r = flow.advance(s, 'tomorrow at 3pm');
  ok('datetime → AWAITING_CONFIRMATION', r.nextStage === flow.STAGES.AWAITING_CONFIRMATION);

  s = { stage: flow.STAGES.AWAITING_CONFIRMATION, patientName: 'Priya Sharma', service: 'cleaning', dateTime: r.updates.dateTime };
  r = flow.advance(s, 'yes');
  ok('confirm → COMPLETED', r.nextStage === flow.STAGES.COMPLETED);
  ok('confirmed flag set', r.updates.confirmed === true);

  console.log('\n▶ State machine — recovery paths');
  r = flow.advance({ stage: flow.STAGES.AWAITING_NAME }, '...');
  ok('unparseable name stays put', r.nextStage === flow.STAGES.AWAITING_NAME);
  r = flow.advance({ stage: flow.STAGES.AWAITING_CONFIRMATION, service: 'cleaning' }, 'no, change the time');
  ok('reject at confirm → back to datetime', r.nextStage === flow.STAGES.AWAITING_DATETIME);

  console.log('\n▶ Orchestrator (mock mode) — full booking + persistence');
  process.env.MOCK_MODE = 'true';
  // Require after setting MOCK_MODE so config picks it up.
  const conversation = require('../src/services/conversation');
  const firestore = require('../src/services/firestore');
  firestore.init();

  const callId = 'test-call-1';
  const phone = '+15551230000';
  await conversation.handleTurn({ callId, userInput: 'my name is Alex Rivera', phone });
  await conversation.handleTurn({ callId, userInput: 'checkup', phone });
  await conversation.handleTurn({ callId, userInput: 'tomorrow at 11am', phone });
  const done = await conversation.handleTurn({ callId, userInput: 'yes', phone });

  ok('orchestrator reaches COMPLETED', done.stage === 'COMPLETED');
  ok('booking object returned', Boolean(done.booking));
  ok('booking has calendar event id', Boolean(done.booking.googleEventId));
  ok('booking has twilio sid', Boolean(done.booking.twilioSid));

  const session = await firestore.getSession(callId);
  ok('session persisted', session.callId === callId);
  ok('same callId resumes (not reset)', session.patientName === 'Alex Rivera');
  ok('state history recorded', session.stateHistory.length >= 4);
  ok('conversation log recorded', session.conversationLog.length >= 4);

  console.log('\n▶ Idempotency — replaying after COMPLETED does not double-book');
  const before = (await firestore.listBookings({})).length;
  await conversation.handleTurn({ callId, userInput: 'yes', phone });
  const after = (await firestore.listBookings({})).length;
  ok('no duplicate booking', before === after);

  console.log(`\n✅ All ${passed} assertions passed.\n`);
}

run().catch((err) => {
  console.error('\n❌', err.message, '\n');
  process.exit(1);
});
