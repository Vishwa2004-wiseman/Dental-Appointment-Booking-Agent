'use strict';

/**
 * Conversation state machine — PURE functions only.
 *
 * No I/O, no Firestore, no side effects. This makes the booking flow trivially
 * unit-testable and keeps the "brain" of the agent separate from persistence
 * and third-party integrations.
 *
 * Flow:
 *   AWAITING_NAME -> AWAITING_SERVICE -> AWAITING_DATETIME -> AWAITING_CONFIRMATION
 *                 -> COMPLETED | CANCELLED
 */

const { parseDateTime } = require('./datetime');

const STAGES = Object.freeze({
  AWAITING_NAME: 'AWAITING_NAME',
  AWAITING_SERVICE: 'AWAITING_SERVICE',
  AWAITING_DATETIME: 'AWAITING_DATETIME',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});

const SERVICES = Object.freeze([
  'cleaning',
  'checkup',
  'filling',
  'extraction',
  'whitening',
  'root canal',
  'emergency',
  'consultation',
]);

const TERMINAL_STAGES = Object.freeze([STAGES.COMPLETED, STAGES.CANCELLED]);

function isTerminal(stage) {
  return TERMINAL_STAGES.includes(stage);
}

/**
 * Prompt the agent should speak for the current stage.
 */
function promptFor(stage, session = {}) {
  switch (stage) {
    case STAGES.AWAITING_NAME:
      return 'Thanks for calling. May I have your full name, please?';
    case STAGES.AWAITING_SERVICE:
      return `Thanks${session.patientName ? `, ${session.patientName}` : ''}. ` +
        `What can we help with — cleaning, checkup, filling, extraction, whitening, ` +
        `root canal, an emergency, or a consultation?`;
    case STAGES.AWAITING_DATETIME:
      return 'Great. What day and time works best for you?';
    case STAGES.AWAITING_CONFIRMATION:
      return `Just to confirm: a ${session.service} for ${session.patientName} on ` +
        `${formatWhen(session.dateTime)}. Shall I book it?`;
    case STAGES.COMPLETED:
      return `You're all set! We've sent a confirmation by text. See you then.`;
    case STAGES.CANCELLED:
      return `No problem — I won't book anything. Call back any time.`;
    default:
      return 'How can I help you today?';
  }
}

function formatWhen(iso) {
  if (!iso) return 'the requested time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// -- Slot extraction (name/service are lightweight; date/time uses NLP) --

function extractName(text) {
  if (!text) return null;
  const cleaned = String(text).trim();
  const m = cleaned.match(/(?:my name is|this is|it'?s|i am|i'm)\s+([a-z][a-z .'-]+)/i);
  const candidate = (m ? m[1] : cleaned).replace(/[^a-zA-Z .'-]/g, ' ').trim();
  if (!candidate) return null;
  if (!/[a-z]/i.test(candidate)) return null; // must contain at least one letter
  return candidate
    .split(/\s+/).slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function extractService(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  const found = [...SERVICES].sort((a, b) => b.length - a.length)
    .find((s) => lower.includes(s));
  if (found) return found;
  if (/\bclean/.test(lower)) return 'cleaning';
  if (/\bcheck/.test(lower)) return 'checkup';
  if (/\bpain|\bhurt|\bbroke|\burgent/.test(lower)) return 'emergency';
  return null;
}

/**
 * Natural-language date/time parsing. Delegates to the NLP parser in
 * ./datetime (chrono-node when installed, rule-based fallback otherwise).
 * Understands "tomorrow at 3pm", "next Friday afternoon", "in two days",
 * "July 5th at 9", "half past two", plain "3pm", ISO strings, etc.
 * Returns an ISO string or null.
 */
function extractDateTime(text, now = new Date()) {
  return parseDateTime(text, now);
}

function isAffirmative(text) {
  return /\b(yes|yeah|yep|yup|correct|sure|confirm|book it|that'?s right|sounds good|go ahead)\b/i
    .test(String(text || ''));
}

function isNegative(text) {
  return /\b(no|nope|nah|cancel|don'?t|stop|wrong|change)\b/i
    .test(String(text || ''));
}

/**
 * Core reducer.
 * @returns {{ nextStage: string, updates: object, reply: string }}
 */
function advance(session, input) {
  const stage = session.stage || STAGES.AWAITING_NAME;
  const text = (input || '').trim();
  const updates = {};

  if (stage !== STAGES.AWAITING_CONFIRMATION && isNegative(text) &&
      /\b(cancel|stop|nevermind|never mind)\b/i.test(text)) {
    return { nextStage: STAGES.CANCELLED, updates, reply: promptFor(STAGES.CANCELLED, session) };
  }

  switch (stage) {
    case STAGES.AWAITING_NAME: {
      const name = extractName(text);
      if (!name) {
        return { nextStage: stage, updates, reply: "Sorry, I didn't catch your name. Could you say it again?" };
      }
      updates.patientName = name;
      const next = { ...session, ...updates, stage: STAGES.AWAITING_SERVICE };
      return { nextStage: STAGES.AWAITING_SERVICE, updates, reply: promptFor(STAGES.AWAITING_SERVICE, next) };
    }

    case STAGES.AWAITING_SERVICE: {
      const service = extractService(text);
      if (!service) {
        return { nextStage: stage, updates, reply: 'Which service would you like? For example, a cleaning or a checkup.' };
      }
      updates.service = service;
      return { nextStage: STAGES.AWAITING_DATETIME, updates, reply: promptFor(STAGES.AWAITING_DATETIME, session) };
    }

    case STAGES.AWAITING_DATETIME: {
      const dt = extractDateTime(text);
      if (!dt) {
        return { nextStage: stage, updates, reply: 'What day and time would you like? For example, "tomorrow at 3pm".' };
      }
      updates.dateTime = dt;
      const next = { ...session, ...updates, stage: STAGES.AWAITING_CONFIRMATION };
      return { nextStage: STAGES.AWAITING_CONFIRMATION, updates, reply: promptFor(STAGES.AWAITING_CONFIRMATION, next) };
    }

    case STAGES.AWAITING_CONFIRMATION: {
      if (isAffirmative(text)) {
        updates.confirmed = true;
        return { nextStage: STAGES.COMPLETED, updates, reply: promptFor(STAGES.COMPLETED, session) };
      }
      if (isNegative(text)) {
        updates.confirmed = false;
        return { nextStage: STAGES.AWAITING_DATETIME, updates, reply: 'No problem — what day and time would you prefer instead?' };
      }
      return { nextStage: stage, updates, reply: 'Should I go ahead and book it? Please say yes or no.' };
    }

    default:
      return { nextStage: stage, updates, reply: promptFor(stage, session) };
  }
}

module.exports = {
  STAGES,
  SERVICES,
  isTerminal,
  promptFor,
  formatWhen,
  extractName,
  extractService,
  extractDateTime,
  isAffirmative,
  isNegative,
  advance,
};
