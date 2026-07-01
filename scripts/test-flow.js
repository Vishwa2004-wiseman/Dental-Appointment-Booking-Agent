'use strict';

/**
 * Zero-dependency tests: state machine, VAPI envelope parsing (against the real
 * sample payloads), the orchestrator, the tool-calls booking path, and the
 * cancel path. Runs anywhere Node runs — no npm install, no cloud credentials.
 *
 * Run:  node scripts/test-flow.js   (or `npm test`)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const flow = require('../src/state/flow');
const parse = require('../src/vapi/parse');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, `FAILED: ${name}`);
  console.log(`  ✅ ${name}`);
  passed++;
}
const sample = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample-payloads', f), 'utf8'));

async function run() {
  console.log('\n▶ State machine — slot extraction');
  ok('extractName strips lead-in', flow.extractName('my name is John Doe') === 'John Doe');
  ok('extractName title-cases', flow.extractName('priya sharma') === 'Priya Sharma');
  ok('extractName rejects punctuation-only', flow.extractName('...') === null);
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

  console.log('\n▶ State machine — recovery & cancel');
  r = flow.advance({ stage: flow.STAGES.AWAITING_NAME }, '...');
  ok('unparseable name stays put', r.nextStage === flow.STAGES.AWAITING_NAME);
  r = flow.advance({ stage: flow.STAGES.AWAITING_CONFIRMATION, service: 'cleaning' }, 'no, change the time');
  ok('reject at confirm → back to datetime', r.nextStage === flow.STAGES.AWAITING_DATETIME);
  r = flow.advance({ stage: flow.STAGES.AWAITING_SERVICE }, 'actually cancel that');
  ok('cancel mid-flow → CANCELLED', r.nextStage === flow.STAGES.CANCELLED);

  console.log('\n▶ VAPI envelope parsing (real sample payloads)');
  const cu = sample('conversation-update.json').message;
  ok('getCallId from conversation-update', parse.getCallId(cu) === 'call-demo-001');
  ok('getPhone from customer.number', parse.getPhone(cu) === '+15551234567');
  ok('latestUserText picks last user turn', parse.latestUserText(cu) === 'Hi, my name is Priya Sharma');
  const tc = sample('tool-calls.json').message;
  const parsedCalls = parse.extractToolCalls(tc);
  ok('extractToolCalls returns one call', parsedCalls.length === 1);
  ok('tool name parsed', parsedCalls[0].name === 'select_service');
  ok('tool args parsed', parsedCalls[0].args.service === 'cleaning');
  ok('type parsed', parse.getType(sample('end-of-call-report.json').message) === 'end-of-call-report');

  console.log('\n▶ Orchestrator (mock mode) — full booking + persistence');
  process.env.MOCK_MODE = 'true';
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

  console.log('\n▶ Tool-calls path drives a booking (structured args)');
  const tcId = 'test-call-tools';
  await conversation.applyToolCall({ callId: tcId, tool: 'collect_patient_info', args: { name: 'Sam Lee', phone }, phone });
  await conversation.applyToolCall({ callId: tcId, tool: 'select_service', args: { service: 'filling' }, phone });
  await conversation.applyToolCall({ callId: tcId, tool: 'select_datetime', args: { dateTime: 'tomorrow at 9am' }, phone });
  const tdone = await conversation.applyToolCall({ callId: tcId, tool: 'confirm_booking', args: {}, phone });
  ok('tool-calls path reaches COMPLETED', tdone.stage === 'COMPLETED');
  ok('tool-calls path creates a booking', Boolean(tdone.booking && tdone.booking.googleEventId));

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
