# fct-dispatch Worker

Production: `https://fct-dispatch.jamesgrunsky.workers.dev`

Excel two-way lives in the calc: **download today's sheet as xlsx**, then
**drop it back to import**. This Worker does **not** write OneDrive Excel
and does not run Power Automate flows.

What this Worker does:

- `GET /latest` — existing dispatch JSON for the calc
- `POST /ingest` — existing JSON-row ingest (`X-FCT-Key` = `INGEST_KEY`)
- `POST /send-sms` — **optional**. Missing provider secrets return
  `"SMS not configured"` so Send dispatch still assigns. No real text in CI.
  Default hook is Twilio if secrets exist later; Sinch/Telnyx can swap.

## Deploy

```bash
cd workers/fct-dispatch
npx wrangler deploy
```

Do not put secrets in git. SMS stays off until someone sets provider env vars.

## Tests

```bash
npm test
```
