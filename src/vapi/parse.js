'use strict';

/**
 * Pure helpers for reading VAPI's webhook envelope. No I/O — unit-testable.
 * VAPI has shifted field names across versions, so each accessor checks the
 * common variants. Docs: https://docs.vapi.ai/server-url
 */

function getMessage(body) {
  return (body && (body.message || body)) || {};
}

function getType(message) {
  return message.type || 'unknown';
}

function getCallId(message) {
  return (
    message?.call?.id ||
    message?.callId ||
    message?.call?.callId ||
    null
  );
}

function getPhone(message) {
  return (
    message?.call?.customer?.number ||
    message?.customer?.number ||
    message?.call?.from ||
    null
  );
}

/** Most recent user utterance from a conversation-update / transcript event. */
function latestUserText(message) {
  const msgs = message?.messages || message?.conversation || message?.artifact?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const role = m.role || m.type;
    if (role === 'user') return m.message || m.content || m.text || '';
  }
  return message?.transcript || message?.text || '';
}

/**
 * Normalise the many tool-call shapes into [{ toolCallId, name, args }].
 * `arguments` may arrive as an object or a JSON string.
 */
function extractToolCalls(message) {
  const raw = message.toolCalls || message.toolCallList || message.tool_calls || [];
  return raw.map((call) => {
    const fn = call.function || call;
    let args = fn.arguments || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch (_) { args = {}; }
    }
    return { toolCallId: call.id || call.toolCallId, name: fn.name, args };
  });
}

module.exports = { getMessage, getType, getCallId, getPhone, latestUserText, extractToolCalls };
