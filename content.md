# content.md — Dental Booking Agent Build Playbook

> **Private build guide.** This is the north-star document: a 48-hour sprint
> checklist a fresher can follow line-by-line from zero to a deployed VAPI dental
> receptionist backend. Public docs live in [README.md](README.md).

---

## Section 1 — Assignment snapshot

**CORE Round 2 brief:** Build the backend for an AI dental-clinic voice agent.
When a patient calls, VAPI (voice AI) sends webhooks to our server. We track a
multi-turn booking conversation, create a Google Calendar event, text an SMS
confirmation, and log everything to Firestore. The system must be architected so
it could scale to ~1,000 clinics.

**The 6 CORE requirements**

| # | Requirement | Where it lives |
|---|-------------|----------------|
| 1 | Accept VAPI call webhooks | `POST /webhooks/vapi` → `src/routes/webhook.js` |
| 2 | Multi-turn conversation state | `src/state/flow.js` + `src/services/conversation.js` |
| 3 | Persist state + transcript | `src/services/firestore.js` |
| 4 | Book into Google Calendar | `src/services/calendar.js` |
| 5 | SMS confirmation | `src/services/sms.js` |
| 6 | Admin visibility (bookings/sessions) | `src/routes/admin.js` |

**Rubric (100 pts):** Working E2E (40), Architecture (20), Code quality (15),
Documentation (15), AI tool use (10).

**Chosen stack (locked)**

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 20+ | Webhooks are just HTTP POSTs; great SDKs |
| Web framework | Express | Minimal, well-understood routing |
| Datastore | Firestore | Serverless, keyed docs, no schema migrations |
| Calendar | Google Calendar API | One service account, per-clinic calendar |
| SMS | Twilio | Industry standard, trial number for testing |
| Hosting | Railway | Git-push deploy, easy env vars, health checks |

---

## Section 2 — Prerequisites checklist

- [ ] **Node.js 20+** and npm — `node -v`
- [ ] **Git** — `git -v`
- [ ] **Railway account** (hosting) — https://railway.app
- [ ] **Firebase project** with Firestore enabled — https://console.firebase.google.com
- [ ] **Google Cloud project** with Calendar API enabled (same project as Firebase is fine)
- [ ] **Twilio trial** (Account SID, Auth Token, a trial phone number) — https://twilio.com
- [ ] **VAPI account** (free tier) — https://vapi.ai

**Where each credential comes from**

| Env var | Source |
|---------|--------|
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Firebase Console → Project Settings → Service accounts → *Generate new private key* (JSON) |
| `GOOGLE_CALENDAR_ID` | Google Calendar → Settings for the target calendar → *Integrate calendar* → Calendar ID. Share that calendar with the service-account email (Make changes to events). |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | Twilio Console dashboard |
| `VAPI_WEBHOOK_SECRET` | VAPI dashboard → Server URL secret (optional) |
| `BASE_URL` | Railway → your service → public domain (set after first deploy) |
| `ADMIN_API_KEY` | You invent it — any long random string |

> **Zero-credential mode:** the app auto-enables `MOCK_MODE` when Firestore creds
> are missing, so you can run `npm run simulate` and `node scripts/test-flow.js`
> before setting anything up.

---

## Section 3 — Hour-by-hour build timeline (48h)

| Phase | Hours | Deliverable |
|-------|-------|-------------|
| Setup | 0–4h | Repo, Express skeleton, health check, first commit |
| Webhook + state | 4–16h | VAPI handler, Firestore session, state machine |
| Integrations | 16–28h | Calendar booking, Twilio SMS |
| Admin API | 28–34h | List bookings, session history |
| Deploy + test | 34–44h | Railway live URL, end-to-end demo |
| Docs + Loom | 44–48h | README polish, video |

Keep the [git rules](#section-7--git-strategy--commit-when-you-face-an-error)
open in a second tab. Target **15–25 commits** over the sprint.

---

## Section 4 — Environment variables

Copy this into `.env.example` (already in the repo) and then `cp .env.example .env`.

```env
# Server
PORT=3000
BASE_URL=                      # Railway public URL
NODE_ENV=development

# Tenant
CLINIC_ID=demo-clinic-001

# Firestore
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=          # quoted, with literal \n newlines

# Google Calendar
GOOGLE_CALENDAR_ID=
GOOGLE_SERVICE_ACCOUNT_JSON=   # optional; falls back to FIREBASE_* creds
APPOINTMENT_DURATION_MINUTES=30
CLINIC_TIMEZONE=Asia/Kolkata

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Admin API
ADMIN_API_KEY=change-me-please

# VAPI (optional signature verification)
VAPI_WEBHOOK_SECRET=

# Feature flags
MOCK_MODE=false                # auto-true when Firestore creds missing
```

> **The `FIREBASE_PRIVATE_KEY` gotcha:** env vars store the key with escaped
> `\n`. `src/config/index.js` calls `.replace(/\\n/g, '\n')` to restore real
> newlines. If you skip that, you get `error:0909006C` PEM parse failures.

---

## Section 5 — Step-by-step implementation

Each step lists **what to build**, **how to test**, and the **commit message** to use.

### 5.1 Init repo
```bash
mkdir dental-booking-agent && cd dental-booking-agent
git init
npm init -y
npm install express firebase-admin googleapis twilio dotenv
```
Set `"type": "commonjs"`, `"engines": { "node": ">=20" }`, and scripts
(`start`, `dev`, `simulate`) in `package.json`.
**Commit:** `chore: scaffold express app with health check`

### 5.2 Config + health route
Build `src/config/index.js` — read/validate env, coerce types, normalize the
Firebase key, and decide `mockMode` (auto-true when Firestore creds are absent).
Build `src/index.js` with `GET /health` returning the config summary.
**Test:** `node src/index.js` then `curl localhost:3000/health`.
**Commit:** `feat: config loader with mock-mode fallback and health check`

### 5.3 Firestore service
`src/services/firestore.js` — collections `sessions`, `bookings`,
`conversationLogs`. Provide `ensureSession`, `saveTurn`, `createBooking`,
`listBookings`, `listSessions`, `getSession`, `archiveTranscript`. In mock mode
back everything with in-memory `Map`s so the same API works offline.
**Commit:** `feat: firestore service with in-memory mock fallback`

### 5.4 State machine (the core rubric point)
`src/state/flow.js` — **pure functions only**. Export `STAGES`, `advance(session,
input)` returning `{ nextStage, updates, reply }`, plus slot extractors
(`extractName`, `extractService`, `extractDateTime`) and intent helpers
(`isAffirmative`, `isNegative`).
**Test:** `node scripts/test-flow.js` (zero dependencies).
**Commit:** `feat: pure conversation state machine (name→service→datetime→confirm)`

### 5.5 Webhook route
`src/routes/webhook.js` — single `POST /vapi`. Parse the VAPI envelope, switch on
`message.type`, and **always return HTTP 200**.

Handle at minimum:
- `tool-calls` → run booking tools, return `{ results: [{ toolCallId, result }] }`
- `conversation-update` / `transcript` → advance the state machine from the latest user turn
- `end-of-call-report` → archive full transcript to Firestore
- `assistant-request` (optional) → return `{ assistantId }` for dynamic routing

**Commit:** `feat: VAPI webhook handler routing on message.type`

### 5.6 VAPI tool definitions (paste into the VAPI dashboard)
Define these function tools on your assistant; each one's server URL is your
`POST /webhooks/vapi`:

| Tool | Arguments | Effect |
|------|-----------|--------|
| `collect_patient_info` | `{ name, phone? }` | store name → `AWAITING_SERVICE` |
| `select_service` | `{ service }` | store service → `AWAITING_DATETIME` |
| `select_datetime` | `{ dateTime }` | store time → `AWAITING_CONFIRMATION` |
| `confirm_booking` | `{}` | confirm → `COMPLETED` (books + texts) |

### 5.7 Google Calendar
`src/services/calendar.js` — `events.insert` on `GOOGLE_CALENDAR_ID`; store the
returned `eventId` on the booking doc. Reuse the Firebase service account (JWT
auth, `calendar` scope) unless `GOOGLE_SERVICE_ACCOUNT_JSON` is set.
**Commit:** `feat: google calendar service-account event creation`

### 5.8 Twilio SMS
`src/services/sms.js` — on `COMPLETED`, send
`"Hi {name}, your {service} is confirmed for {date} at {time}."`
Store the returned `sid` on the booking.
**Commit:** `feat: twilio sms on booking confirmation`

### 5.9 Orchestrator
`src/services/conversation.js` — ties state machine + persistence + fulfilment.
`handleTurn()` advances one turn; when it reaches `COMPLETED` it calls
`fulfilBooking()` (calendar + SMS + booking doc) exactly once (idempotent via a
stored `bookingId`).
**Commit:** `feat: conversation orchestrator wires state → calendar → sms`

### 5.10 Admin API
`src/routes/admin.js` — guard every route with an `X-Admin-Key` header equal to
`ADMIN_API_KEY`.
- `GET /admin/bookings`
- `GET /admin/sessions` (list)
- `GET /admin/sessions/:callId` (full detail + history + transcript)

**Commit:** `feat: admin REST api with api-key auth`

### 5.11 Local simulation
`scripts/simulate-webhook.js` boots the app in-process and fires 4 VAPI-shaped
webhooks (name → service → datetime → confirm), then hits the admin API to prove
the session + booking persisted. `scripts/test-flow.js` unit-tests the state
machine with zero deps.
**Test:** `node scripts/test-flow.js` then `npm run simulate`.
**Commit:** `test: end-to-end simulation + state-machine unit tests`

### 5.12 Railway deploy
Push to GitHub → Railway *New Project → Deploy from GitHub repo* → set env vars →
Railway builds with Nixpacks and runs `npm start`. `railway.json` pins the start
command and `/health` healthcheck.
**Test:** `curl https://<your-app>.up.railway.app/health`.
**Commit:** `chore: railway config (start command + health check path)`

### 5.13 End-to-end test on live URL
Point your VAPI assistant's server URL at the Railway domain, place a test call
(or POST the sample payloads), and verify: session in Firestore, event on the
calendar, SMS received.
**Commit:** `docs: record live URL and e2e verification`

---

## Section 6 — Firestore data model

```
sessions/{callId}
  clinicId, phone, stage, patientName, service, dateTime, confirmed, bookingId
  stateHistory: [{ stage, at, input }]
  conversationLog: [{ role, message, at }]
  createdAt, updatedAt

bookings/{bookingId}
  callId, clinicId, patientName, service, startTime, endTime
  googleEventId, calendarLink, twilioSid, status
  createdAt

conversationLogs/{callId}
  summary, transcript, messages[], endedReason, at
```

**Why `callId` as the session key:** the same patient may call twice, so keying
on phone alone would collide. `message.call.id` is unique per call and lets a
dropped-and-redialled caller start a clean session while a mid-call webhook
resumes the existing one.

---

## Section 7 — Git strategy: "commit when you face an error"

**Rule: never stay stuck more than 30 minutes without a commit.** Commits are a
safety net *and* the build history evaluators want to see.

| Situation | What to commit | Example message |
|-----------|----------------|-----------------|
| Before something risky | Current working state | `wip: before adding calendar service` |
| Error you can't fix yet | Broken code + notes | `wip: calendar auth failing - invalid_grant` |
| Fixed the error | Working fix | `fix: google calendar service account key parsing` |
| Milestone works | Clean feature | `feat: twilio sms on booking confirmation` |

**Commit message format**
```
type: short description
- what I tried
- error message (if any)
- next step
```
Types: `feat`, `fix`, `chore`, `docs`, `test`, `wip`.

**Branch strategy (simple):** work on `main`, always deployable or clearly marked
WIP in the README. Optionally use `feat/webhook`, `feat/calendar` and merge when
green.

**What NOT to commit:** `.env`, the service-account JSON, any Twilio/Firebase
secrets. Only `.env.example` is tracked. `.gitignore` already covers
`node_modules/`, `.env`, `*serviceAccount*.json`, `*.pem`, `*.key`.

**Frequency target:** 15–25 commits across the 48 hours.

---

## Section 8 — Testing checklist (pass criteria mapped)

- [ ] `POST /webhooks/vapi` accepts VAPI-shaped JSON and returns 200
- [ ] Same `callId` resumes mid-flow (session is not reset)
- [ ] Google Calendar event appears on the test calendar
- [ ] Twilio SMS received on the test phone
- [ ] Firestore holds full `conversationLog` + `stateHistory`
- [ ] `GET /admin/bookings` and `GET /admin/sessions/:callId` return data
- [ ] Live Railway URL responds on `/health`
- [ ] `node scripts/test-flow.js` → all assertions pass
- [ ] `npm run simulate` → full booking completes end-to-end

---

## Section 9 — Known corners cut (mention in Loom)

1. **No VAPI signature verification by default** — scaffolded behind
   `VAPI_WEBHOOK_SECRET`; enable in production.
2. **Single clinic via `CLINIC_ID` env var** — data model is multi-tenant
   (`clinicId` on every doc) but there's no clinic-management UI.
3. **Simple string parsing for slots** instead of full NLP — real deployments
   should let VAPI tool-calls supply structured arguments.
4. **Admin API-key auth only** — no OAuth admin dashboard.

---

## Section 10 — Loom video script (≈3 minutes)

Conversational, beginner-friendly — read it aloud, don't recite robotically.

**[0:00–0:20] Intro**
> "Hi, I'm Sargunam. I built a backend for a dental clinic voice agent — when
> someone calls, VAPI sends webhooks to my server, I track the conversation step
> by step, book into Google Calendar, and text a confirmation."

**[0:20–1:00] Architecture** *(screen: README diagram or Railway dashboard)*
> "I used Node and Express because webhooks are just HTTP POST requests, and
> there's great library support for Google, Twilio, and Firebase. Everything goes
> through one webhook endpoint. I look at the message type — mostly `tool-calls`
> during the call and `end-of-call-report` when it finishes. Conversation state
> lives in Firestore keyed by call ID, so if the caller drops and calls back,
> each call is its own session."

**[1:00–1:45] State machine** *(screen: Firestore doc or `flow.js`)*
> "The flow is four steps: name, service, date/time, confirm. Each webhook
> updates the stage and saves history. I did it this way instead of keeping state
> in memory because if Railway restarts, we don't lose the conversation. For
> 1,000 clinics I'd add a clinic ID on every record and map phone numbers to
> clinics."

**[1:45–2:30] Live demo** *(screen: simulate script → Firestore → Calendar → SMS)*
> "Let me show it working. I send a test webhook like VAPI would… you can see the
> session in Firestore… here's the calendar event… and the SMS just came through."

**[2:30–3:00] Tradeoffs + AI tools**
> "Under 48 hours I skipped webhook signature verification and built key-based
> admin auth. With more time I'd add that plus a proper admin dashboard. I used
> Claude/Cursor to research VAPI's webhook format and scaffold integrations, but
> I walked through every file so I can explain it — like this video. Thanks for
> watching."

---

## Appendix — Quick command reference

```bash
# install
npm install

# fast logic check (no deps, no creds)
node scripts/test-flow.js

# full in-process end-to-end (mock mode)
npm run simulate

# run the server
npm run dev          # watch mode
npm start            # production

# health
curl localhost:3000/health

# admin (needs ADMIN_API_KEY)
curl -H "X-Admin-Key: $ADMIN_API_KEY" localhost:3000/admin/bookings
```

**Reference:** VAPI Server URL docs — https://docs.vapi.ai/server-url
