'use strict';

/**
 * VAPI server webhook — the single entry point for the voice agent.
 *
 * VAPI wraps every event as: { message: { type, call, ... } }
 * We route on `message.type`:
 *   - tool-calls          -> run booking tools, return { results: [...] }
 *   - conversation-update -> advance the state machine from the latest user turn
 *   - end-of-call-report  -> archive the full transcript
 *   - assistant-request   -> (optional) dynamic assistant routing
 *   - status-update       -> acknowledged, no-op
 *
 * Golden rule: ALWAYS respond HTTP 200 with a JSON body. A non-200 makes VAPI
 * retry or drop the call. Errors are caught and logged, never thrown to VAPI.
 *
 * Envelope parsing lives in ../vapi/parse.js (pure + unit-tested).
 * Docs: https://docs.vapi.ai/server-url
 */

const express = require('express');
const crypto = require('crypto');
const conversation = require('../services/conversation');
const firestore = require('../services/firestore');
const parse = require('../vapi/parse');
const { config } = require('../config');

const router = express.Router();

/**
 * Optional HMAC / shared-secret signature check. If no secret is configured we
 * skip verification (documented corner cut).
 */
function verifySignature(req) {
  if (!config.vapi.webhookSecret) return true;
  const provided = req.get('x-vapi-signature') || req.get('x-vapi-secret') || '';
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

router.post('/vapi', async (req, res) => {
  try {
    if (!verifySignature(req)) {
      console.warn('[webhook] signature verification failed');
      return res.status(200).json({ error: 'invalid_signature' });
    }

    const message = parse.getMessage(req.body);
    const type = parse.getType(message);
    const callId = parse.getCallId(message);
    const phone = parse.getPhone(message);

    console.log(`[webhook] type=${type} callId=${callId || 'n/a'}`);

    switch (type) {
      case 'tool-calls':
        return res.status(200).json(await handleToolCalls(message, { callId, phone }));

      case 'conversation-update':
      case 'transcript': {
        const userText = parse.latestUserText(message);
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
    console.error('[webhook] handler error:', err.stack || err.message);
    return res.status(200).json({ ok: false, error: 'handler_error' });
  }
});

/**
 * Execute VAPI tool-calls, returning results in the exact shape VAPI expects:
 *   { results: [{ toolCallId, result }] }
 */
async function handleToolCalls(message, { callId, phone }) {
  const calls = parse.extractToolCalls(message);
  const results = [];
  for (const { toolCallId, name, args } of calls) {
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
      results.push({ toolCallId, result: JSON.stringify({ success: false, error: err.message }) });
    }
  }
  return { results };
}

module.exports = router;
