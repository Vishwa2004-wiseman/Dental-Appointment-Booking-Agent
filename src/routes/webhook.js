'use strict';

/**
 * VAPI server webhook — the single entry point for the voice agent.
 *
 * VAPI wraps every event as: { message: { type, call, ... } }
 * We route on `message.type`:
 *   - tool-calls          → run booking tools, return { results: [...] }
 *   - conversation-update → advance the state machine from the latest user turn
 *   - end-of-call-report  → archive the full transcript
 *   - assistant-request   → (optional) dynamic assistant routing
 *   - status-update       → acknowledged, no-op
 *
 * Golden rule: ALWAYS respond HTTP 200 with a JSON body. A non-200 makes VAPI
 * retry or drop the call. Errors are caught and logged, never thrown to VAPI.
 *
 * Docs: https://docs.vapi.ai/server-url
 */

const express = require('express');
const crypto = require('crypto');
const conversation = require('../services/conversation');
const firestore = require('../services/firestore');
const { config } = require('../config');

const router = express.Router();

/**
 * Optional HMAC signature check. VAPI can send a secret header; if we have a
 * secret configured we verify it, otherwise we skip (documented corner cut).
 */
function verifySignature(req) {
  if (!config.vapi.webhookSecret) return true; // verification disabled
  const provided =
    req.get('x-vapi-signature') || req.get('x-vapi-secret') || '';
  // Support either a shared-secret match or an HMAC of the raw body.
  if (provided === config.vapi.webhookSecret) return true;
  try {
    const hmac = crypto
      .createHmac('sha256', config.vapi.webhookSecret)
      .update(JSON.stringify(req.body))
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(provided));
  } catch (_) {
    return false;
  }
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

// Pull the most recent *user* utterance out of a conversation-update payload.
function latestUserText(message) {
  const msgs = message?.messages || message?.conversation || message?.artifact?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const role = m.role || m.type;
    if (role === 'user') return m.message || m.content || m.text || '';
  }
  // Fall back to a flat transcript field if present.
  return message?.transcript || message?.text || '';
}

router.post('/vapi', async (req, res) => {
  // Never let anything throw past here — VAPI must always get a 200.
  try {
    if (!verifySignature(req)) {
      console.warn('[webhook] signature verification failed');
      return res.status(200).json({ error: 'invalid_signature' });
    }

    const message = req.body?.message || req.body || {};
    const type = message.type || 'unknown';
    const callId = getCallId(message);
    const phone = getPhone(message);

    console.log(`[webhook] type=${type} callId=${callId || 'n/a'}`);

    switch (type) {
      case 'tool-calls':
        return res.status(200).json(await handleToolCalls(message, { callId, phone }));

      case 'conversation-update':
      case 'transcript': {
        const userText = latestUserText(message);
        if (!callId) return res.status(200).json({ ok: true, note: 'no callId' });
        const result = await conversation.handleTurn({ callId, userInput: userText, phone });
        return res.status(200).json({ ok: true, reply: result.reply, stage: result.stage });
      }

      case 'end-of-call-report':
        if (callId) {
          await firestore.archiveTranscript(callId, {
            summary: message.summary || null,
            transcript: message.transcript || null,
            messages: message.messages || message.artifact?.messages || [],
            endedReason: message.endedReason || null,
          });
        }
        return res.status(200).json({ ok: true });

      case 'assistant-request':
        // Optional dynamic routing. Return an assistantId if you map numbers → clinics.
        return res.status(200).json({});

      case 'status-update':
      case 'speech-update':
      case 'hang':
        return res.status(200).json({ ok: true });

      default:
        console.log('[webhook] unhandled type:', type);
        return res.status(200).json({ ok: true, note: `unhandled type ${type}` });
    }
  } catch (err) {
    // Log loudly but still answer 200 so VAPI does not retry-storm.
    console.error('[webhook] handler error:', err.stack || err.message);
    return res.status(200).json({ ok: false, error: 'handler_error' });
  }
});

/**
 * Execute VAPI tool-calls and return results in the exact shape VAPI expects:
 *   { results: [{ toolCallId, result }] }
 */
async function handleToolCalls(message, { callId, phone }) {
  const toolCalls =
    message.toolCalls ||
    message.toolCallList ||
    message.tool_calls ||
    [];

  const results = [];
  for (const call of toolCalls) {
    const toolCallId = call.id || call.toolCallId;
    const fn = call.function || call;
    const name = fn.name;
    let args = fn.arguments || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch (_) { args = {}; }
    }

    try {
      const outcome = await conversation.applyToolCall({ callId, tool: name, args, phone });
      results.push({
        toolCallId,
        result: JSON.stringify({
          success: true,
          stage: outcome.stage,
          message: outcome.reply,
          booking: outcome.booking ? { id: outcome.booking.bookingId, status: outcome.booking.status } : undefined,
        }),
      });
    } catch (err) {
      console.error(`[webhook] tool ${name} failed:`, err.message);
      results.push({
        toolCallId,
        result: JSON.stringify({ success: false, error: err.message }),
      });
    }
  }

  return { results };
}

module.exports = router;
