'use strict';

/**
 * Natural-language date/time parsing.
 *
 * Primary parser: `chrono-node` — a proper NLP date library that understands
 * free-form phrasing ("next Friday afternoon", "the 3rd at half past two",
 * "in a couple of days", "July 5th at 9"). It is used automatically whenever the
 * dependency is installed (it is in package.json, so the deployed app uses it).
 *
 * Fallback parser: a self-contained rule-based parser used when chrono-node is
 * not available (e.g. offline test runs with no node_modules). It covers the
 * common phrasings so the flow never hard-depends on the library.
 *
 * Both return an ISO 8601 string (future-biased) or null.
 */

// -- chrono-node (optional, loaded lazily & safely) --------------------------

let _chrono = null;
let _chronoTried = false;

function getChrono() {
  if (_chronoTried) return _chrono;
  _chronoTried = true;
  try {
    _chrono = require('chrono-node');
  } catch (_) {
    _chrono = null; // library not installed → use fallback
  }
  return _chrono;
}

function parseWithChrono(text, now) {
  const chrono = getChrono();
  if (!chrono) return null;
  try {
    // forwardDate: bare days/times resolve to the *next* future occurrence,
    // which is what a booking caller means ("Friday" = the upcoming Friday).
    const d = chrono.parseDate(String(text), now, { forwardDate: true });
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch (_) {
    return null;
  }
}

// -- Rule-based fallback ------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// Named times of day → default hour.
const DAYPARTS = { morning: 9, noon: 12, afternoon: 14, evening: 18, night: 20, midnight: 0 };

function parseTimeOfDay(lower) {
  // "half past 2", "quarter past 3", "quarter to 5"
  let m = lower.match(/\b(quarter|half)\s+(past|to)\s+(\d{1,2})\s*(am|pm)?/);
  if (m) {
    let hour = parseInt(m[3], 10);
    let minute = m[1] === 'half' ? 30 : 15;
    if (m[2] === 'to') { minute = 60 - minute; hour -= 1; }
    const ampm = m[4];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { hour: (hour + 24) % 24, minute };
  }

  // "3pm", "3:30 pm", "3.30pm", "at 9", "15:00"
  m = lower.match(/\b(?:at\s*)?(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?\b/);
  if (m && (m[3] || /\b(?:at|by|around)\b/.test(lower) || /:|\./.test(m[0]))) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = (m[3] || '').replace(/\./g, '');
    if (ampm === 'pm' && hour < 12) hour += 12;
    else if (ampm === 'am' && hour === 12) hour = 0;
    else if (!ampm && hour >= 1 && hour <= 7) hour += 12; // clinic hours: "at 3" → 3pm
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  // Named part of day (word-boundary so "afternoon" doesn't match "noon").
  for (const [word, hour] of Object.entries(DAYPARTS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return { hour, minute: 0 };
  }
  return null;
}

function ruleParse(text, now = new Date()) {
  if (!text) return null;
  const raw = String(text).trim();

  // Explicit ISO / machine dates pass straight through.
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime()) && /\d{4}-\d{2}-\d{2}/.test(raw)) {
    return direct.toISOString();
  }

  const lower = raw.toLowerCase();
  const base = new Date(now);
  base.setSeconds(0, 0);

  let dayOffset = null;
  let absoluteDate = null; // {month, day}

  // Relative day words.
  if (/\bday after tomorrow\b/.test(lower)) dayOffset = 2;
  else if (/\btomorrow\b/.test(lower)) dayOffset = 1;
  else if (/\btoday\b|\btonight\b/.test(lower)) dayOffset = 0;

  // "in N days / weeks / hours / minutes" (also "in a day", "in a week").
  const inMatch = lower.match(/\bin\s+(a|an|one|two|three|four|five|six|seven|\d+)\s+(day|days|week|weeks|hour|hours|minute|minutes|min|mins)\b/);
  if (inMatch) {
    const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = words[inMatch[1]] != null ? words[inMatch[1]] : parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    const r = new Date(base);
    if (/^day/.test(unit)) r.setDate(r.getDate() + n);
    else if (/^week/.test(unit)) r.setDate(r.getDate() + n * 7);
    else if (/^hour/.test(unit)) r.setHours(r.getHours() + n);
    else r.setMinutes(r.getMinutes() + n);
    return r.toISOString();
  }

  // "next week" (no specific weekday) → one week out.
  if (dayOffset === null && /\bnext week\b/.test(lower)) dayOffset = 7;

  // Weekday, optionally "next"/"this".
  const wdIdx = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(lower));
  if (wdIdx >= 0 && dayOffset === null) {
    const cur = base.getDay();
    let delta = (wdIdx - cur + 7) % 7;
    if (delta === 0) delta = 7;            // "monday" on a Monday → next Monday
    if (/\bnext\b/.test(lower) && delta <= 0) delta += 7;
    dayOffset = delta;
  }

  // Absolute "July 5", "5 July", "5th of July", "the 15th".
  const monthIdx = MONTHS.findIndex((mo) => lower.includes(mo));
  if (monthIdx >= 0) {
    const dayM = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (dayM) absoluteDate = { month: monthIdx, day: parseInt(dayM[1], 10) };
  } else {
    const ordinal = lower.match(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/) || lower.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
    if (ordinal) absoluteDate = { month: base.getMonth(), day: parseInt(ordinal[1], 10) };
  }

  const time = parseTimeOfDay(lower);

  if (dayOffset === null && absoluteDate === null && !time) return null;

  const result = new Date(base);

  if (absoluteDate) {
    result.setMonth(absoluteDate.month, absoluteDate.day);
    if (result < now) result.setFullYear(result.getFullYear() + 1); // roll to next year if past
  } else if (dayOffset !== null) {
    result.setDate(result.getDate() + dayOffset);
  }

  if (time) result.setHours(time.hour, time.minute, 0, 0);
  else result.setHours(10, 0, 0, 0); // sensible default slot

  // Bare time with no day → push to the next future occurrence.
  if (dayOffset === null && absoluteDate === null && result <= now) {
    result.setDate(result.getDate() + 1);
  }

  return result.toISOString();
}

// -- Public API ---------------------------------------------------------------

/**
 * Parse a natural-language date/time into an ISO string (or null).
 * Uses chrono-node when available, else the rule-based fallback.
 */
function parseDateTime(text, now = new Date()) {
  if (!text) return null;
  return parseWithChrono(text, now) || ruleParse(text, now);
}

module.exports = { parseDateTime, ruleParse, usingChrono: () => Boolean(getChrono()) };
