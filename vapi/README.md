# VAPI wiring

1. Deploy the backend and note the public URL (e.g. `https://your-app.up.railway.app`).
2. In the VAPI dashboard, create an assistant using `assistant.example.json` as a
   starting point. Replace every `{{BASE_URL}}` with your deployed URL.
3. Add the four function tools from `tools.json` to the assistant (each one's
   `server.url` is your `POST /webhooks/vapi`).
4. Set the assistant **Server URL** to `{{BASE_URL}}/webhooks/vapi` and enable the
   server messages: `tool-calls`, `conversation-update`, `end-of-call-report`.
5. (Optional) Set a Server URL Secret and put the same value in
   `VAPI_WEBHOOK_SECRET` to enable signature verification.
6. Place a test call. The server advances the state machine on each tool-call and
   books + texts on `confirm_booking`.

The backend also accepts free-text `conversation-update` events, so it works even
if you don't register the tools — see `../sample-payloads/`.
