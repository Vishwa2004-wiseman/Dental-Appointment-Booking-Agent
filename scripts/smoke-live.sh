#!/usr/bin/env bash
# Smoke-test a DEPLOYED instance end-to-end. Great to run while recording the Loom.
#
# Usage:
#   BASE_URL=https://your-app.up.railway.app ADMIN_API_KEY=yourkey ./scripts/smoke-live.sh
set -euo pipefail

BASE_URL="${BASE_URL:?set BASE_URL to your deployed URL}"
ADMIN_API_KEY="${ADMIN_API_KEY:-change-me-please}"
CALL_ID="smoke-$(date +%s)"
PHONE="+15551234567"
DIR="$(cd "$(dirname "$0")/.." && pwd)/sample-payloads"

hit() { # type, user_text
  curl -s -X POST "$BASE_URL/webhooks/vapi" -H 'content-type: application/json' \
    -d "{\"message\":{\"type\":\"conversation-update\",\"call\":{\"id\":\"$CALL_ID\",\"customer\":{\"number\":\"$PHONE\"}},\"messages\":[{\"role\":\"user\",\"message\":\"$1\"}]}}"
  echo
}

echo "== health =="
curl -s "$BASE_URL/health"; echo; echo

echo "== conversation =="
hit "my name is Priya Sharma"
hit "I'd like a cleaning"
hit "tomorrow at 3pm"
hit "yes that sounds good"

echo "== admin: session =="
curl -s "$BASE_URL/admin/sessions/$CALL_ID" -H "x-admin-key: $ADMIN_API_KEY"; echo; echo
echo "== admin: bookings =="
curl -s "$BASE_URL/admin/bookings" -H "x-admin-key: $ADMIN_API_KEY"; echo

echo
echo "Now verify: calendar event created + SMS received. If /health shows mock, set real creds."
