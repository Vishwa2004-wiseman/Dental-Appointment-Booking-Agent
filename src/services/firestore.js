'use strict';

/**
 * Firestore access layer.
 *
 * Collections:
 *   sessions/{callId}        — live conversation state + history + transcript
 *   bookings/{bookingId}     — confirmed appointments
 *   conversationLogs/{callId}— full end-of-call transcripts (append-only archive)
 *
 * When Firestore is not configured (MOCK_MODE), everything is kept in an
 * in-process Map so the whole flow still works locally. The public API is
 * identical in both modes, so no caller needs to know which is active.
 */

const { config } = require('../config');

let db = null; // real Firestore handle, or null in mock mode
let FieldValueServerTimestamp = () => new Date().toISOString();

// ── In-memory stores used only in mock mode ──
const memory = {
  sessions: new Map(),
  bookings: new Map(),
  conversationLogs: new Map(),
};

function init() {
  if (!config.hasFirebase || config.mockMode) {
    console.log('[firestore] running in MOCK mode (in-memory store)');
    return;
  }
  // Lazy-require so the app boots even if the dependency is missing in mock mode.
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: config.firebase.projectId,
        clientEmail: config.firebase.clientEmail,
        privateKey: config.firebase.privateKey,
      }),
    });
  }
  db = admin.firestore();
  FieldValueServerTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
  console.log('[firestore] connected to project', config.firebase.projectId);
}

function nowIso() {
  return new Date().toISOString();
}

// ─────────────────────────── Sessions ───────────────────────────

async function getSession(callId) {
  if (!db) return memory.sessions.get(callId) || null;
  const snap = await db.collection('sessions').doc(callId).get();
  return snap.exists ? snap.data() : null;
}

/**
 * Create a fresh session document for a brand-new call.
 */
async function createSession(callId, { clinicId, phone }) {
  const doc = {
    callId,
    clinicId: clinicId || config.clinicId,
    phone: phone || null,
    stage: 'AWAITING_NAME',
    patientName: null,
    service: null,
    dateTime: null,
    confirmed: false,
    stateHistory: [],
    conversationLog: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (!db) {
    memory.sessions.set(callId, doc);
    return doc;
  }
  await db.collection('sessions').doc(callId).set(doc);
  return doc;
}

/**
 * Load-or-create in one call — the webhook uses this on every hit.
 */
async function ensureSession(callId, meta) {
  const existing = await getSession(callId);
  if (existing) return existing;
  return createSession(callId, meta);
}

/**
 * Persist an advanced session: apply slot updates, append a state-history
 * entry and a conversation-log line, and bump updatedAt.
 */
async function saveTurn(callId, { updates, stage, userInput, agentReply }) {
  const current = (await getSession(callId)) || (await createSession(callId, {}));

  const historyEntry = { stage, at: nowIso(), input: userInput || null };
  const logEntries = [];
  if (userInput) logEntries.push({ role: 'user', message: userInput, at: nowIso() });
  if (agentReply) logEntries.push({ role: 'assistant', message: agentReply, at: nowIso() });

  const merged = {
    ...current,
    ...updates,
    stage,
    stateHistory: [...(current.stateHistory || []), historyEntry],
    conversationLog: [...(current.conversationLog || []), ...logEntries],
    updatedAt: nowIso(),
  };

  if (!db) {
    memory.sessions.set(callId, merged);
    return merged;
  }
  await db.collection('sessions').doc(callId).set(merged, { merge: true });
  return merged;
}

async function listSessions({ clinicId, limit = 100 } = {}) {
  if (!db) {
    let all = [...memory.sessions.values()];
    if (clinicId) all = all.filter((s) => s.clinicId === clinicId);
    return all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, limit);
  }
  let q = db.collection('sessions');
  if (clinicId) q = q.where('clinicId', '==', clinicId);
  const snap = await q.limit(limit).get();
  return snap.docs.map((d) => d.data());
}

// ─────────────────────────── Bookings ───────────────────────────

async function createBooking(booking) {
  const doc = { ...booking, createdAt: nowIso() };
  if (!db) {
    memory.bookings.set(doc.bookingId, doc);
    return doc;
  }
  await db.collection('bookings').doc(doc.bookingId).set(doc);
  return doc;
}

async function updateBooking(bookingId, patch) {
  if (!db) {
    const cur = memory.bookings.get(bookingId) || {};
    const next = { ...cur, ...patch, updatedAt: nowIso() };
    memory.bookings.set(bookingId, next);
    return next;
  }
  await db.collection('bookings').doc(bookingId).set({ ...patch, updatedAt: nowIso() }, { merge: true });
  const snap = await db.collection('bookings').doc(bookingId).get();
  return snap.data();
}

async function listBookings({ clinicId, limit = 100 } = {}) {
  if (!db) {
    let all = [...memory.bookings.values()];
    if (clinicId) all = all.filter((b) => b.clinicId === clinicId);
    return all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, limit);
  }
  let q = db.collection('bookings');
  if (clinicId) q = q.where('clinicId', '==', clinicId);
  const snap = await q.limit(limit).get();
  return snap.docs.map((d) => d.data());
}

// ─────────────────────── Conversation logs ──────────────────────

/**
 * Archive a full transcript (typically on end-of-call-report).
 */
async function archiveTranscript(callId, payload) {
  const doc = { callId, ...payload, at: nowIso() };
  if (!db) {
    memory.conversationLogs.set(callId, doc);
    return doc;
  }
  await db.collection('conversationLogs').doc(callId).set(doc, { merge: true });
  return doc;
}

module.exports = {
  init,
  getSession,
  createSession,
  ensureSession,
  saveTurn,
  listSessions,
  createBooking,
  updateBooking,
  listBookings,
  archiveTranscript,
  // exposed for tests / introspection
  _memory: memory,
};
