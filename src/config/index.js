'use strict';

/**
 * Centralised, validated configuration.
 *
 * Every module imports config from here instead of reading `process.env`
 * directly. This gives us one place to validate, coerce types, and decide
 * whether we run against real integrations or in MOCK_MODE.
 *
 * MOCK_MODE is auto-enabled when core credentials are missing, so a fresh
 * clone runs end-to-end (`npm run simulate`) with zero setup.
 */

// Load .env if dotenv is installed. It's optional: in production (Railway)
// env vars are injected directly, and tests run without node_modules.
try { require('dotenv').config(); } catch (_) { /* dotenv not installed — fine */ }

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Firestore private keys are stored with escaped newlines in env vars.
function normalizeKey(key) {
  if (!key) return '';
  return key.replace(/\\n/g, '\n');
}

const firebase = {
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
  privateKey: normalizeKey(process.env.FIREBASE_PRIVATE_KEY),
};

const hasFirebase = Boolean(
  firebase.projectId && firebase.clientEmail && firebase.privateKey
);

const twilio = {
  accountSid: process.env.TWILIO_ACCOUNT_SID || '',
  authToken: process.env.TWILIO_AUTH_TOKEN || '',
  fromNumber: process.env.TWILIO_PHONE_NUMBER || '',
};

const hasTwilio = Boolean(twilio.accountSid && twilio.authToken && twilio.fromNumber);

const google = {
  calendarId: process.env.GOOGLE_CALENDAR_ID || '',
  serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  appointmentDurationMinutes: int(process.env.APPOINTMENT_DURATION_MINUTES, 30),
  timezone: process.env.CLINIC_TIMEZONE || 'Asia/Kolkata',
};

const hasGoogle = Boolean(google.calendarId && (google.serviceAccountJson || hasFirebase));

// If the operator did not explicitly set MOCK_MODE, turn it on automatically
// whenever the critical backing service (Firestore) is not configured.
const explicitMock = process.env.MOCK_MODE !== undefined && process.env.MOCK_MODE !== '';
const mockMode = explicitMock ? bool(process.env.MOCK_MODE) : !hasFirebase;

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  baseUrl: process.env.BASE_URL || '',
  clinicId: process.env.CLINIC_ID || 'demo-clinic-001',

  mockMode,

  firebase,
  hasFirebase,

  google,
  hasGoogle,

  twilio,
  hasTwilio,

  admin: {
    apiKey: process.env.ADMIN_API_KEY || '',
  },

  vapi: {
    webhookSecret: process.env.VAPI_WEBHOOK_SECRET || '',
  },
};

/**
 * Log a startup summary so it is obvious which integrations are live.
 * Never logs secret values.
 */
function summary() {
  return {
    env: config.env,
    port: config.port,
    clinicId: config.clinicId,
    mockMode: config.mockMode,
    firestore: config.hasFirebase ? 'live' : 'mock',
    calendar: config.hasGoogle && !config.mockMode ? 'live' : 'mock',
    sms: config.hasTwilio && !config.mockMode ? 'live' : 'mock',
    adminAuth: config.admin.apiKey ? 'enabled' : 'OPEN (set ADMIN_API_KEY!)',
    vapiSignature: config.vapi.webhookSecret ? 'enabled' : 'disabled',
  };
}

module.exports = { config, summary };
