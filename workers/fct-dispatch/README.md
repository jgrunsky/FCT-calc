# fct-dispatch Worker

Cloudflare Worker behind `https://fct-dispatch.jamesgrunsky.workers.dev`.

Serves the dispatch log (`GET /latest`, `POST /ingest`) that the calc pulls
on boot, and — as of v2.1.41 — driver SMS at `POST /sms`.

**Twilio keys stay on this Worker.** The phone app POSTs `{ to, driver,
origin, dest, appt, po }` and never stores `TWILIO_*`. If those secrets are
missing, `/sms` returns `{ ok:false, error:"SMS not configured" }` with HTTP
200 so the in-app assignment still stands.

## Deploy

Secrets (`INGEST_KEY`) and the `DISPATCH` KV binding already exist on the
live worker. Add Twilio secrets before expecting a real text:

```bash
cd workers/fct-dispatch
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM
npx wrangler deploy
```

Never commit secret values. Do not send a real text from CI — `npm test`
uses a fake fetch.

Confirm:

```bash
curl -s https://fct-dispatch.jamesgrunsky.workers.dev/health
curl -s https://fct-dispatch.jamesgrunsky.workers.dev/latest | head -c 200

curl -s -X POST https://fct-dispatch.jamesgrunsky.workers.dev/sms \
  -H 'content-type: application/json' \
  -d '{"to":"+15555550100","driver":"Greg","origin":"PNG","dest":"LATHROP","appt":"6am","po":"75811-49"}'
# Without Twilio secrets: {"ok":false,"sent":false,"error":"SMS not configured"}
```

## What this deploy must not break

`GET /latest`, `POST /ingest` (X-FCT-Key), `GET /health`, and CORS
`Access-Control-Allow-Origin: *`. The Office Script / Power Automate ingest
path is unchanged.
