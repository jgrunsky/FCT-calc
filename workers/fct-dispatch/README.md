# fct-dispatch Worker

Production: `https://fct-dispatch.jamesgrunsky.workers.dev`

Power Automate is the Excel two-way bridge. Hotmail / Outlook.com Microsoft
account. This Worker is the hop the calc talks to — James builds the two
flows in Microsoft (no flow designer in the HTML app).

**Flow 1 — Excel → app.** OneDrive file-modified (or a scheduled Get file
content) POSTs the dispatch log here. JSON rows *or* xlsx bytes. Header
`X-FCT-Key` = the `INGEST_KEY` secret (paste the same value into PA). The
calc GETs `/latest` (or `/latest.xlsx`) and runs the same importer it uses
for a dropped file.

**Flow 2 — app → Excel.** Settings holds the HTTP trigger URL. On Send
dispatch / assign, the calc POSTs `{ date, po, origin, dest, driver, truck,
status, … }` to this Worker’s `/push-row`, which forwards to that URL so PA
can Update a row. Empty URL → skip, assignment still records in the app.

Twilio is the default SMS provider (company number), not the only possible
one. `SMS_PROVIDER` + a `send()` hook swap Sinch or Telnyx later. Missing
`TWILIO_*` secrets return `"SMS not configured"` and do **not** fail the
assignment. Never commit secrets. CI does not send real texts.

## Deploy

```bash
cd workers/fct-dispatch
npx wrangler deploy
npx wrangler secret put INGEST_KEY
# optional SMS
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM
```

`DISPATCH` KV is already bound. `wrangler deploy` updates the script only.

## Endpoints

| Method | Path | Auth | Role |
|--------|------|------|------|
| POST | `/ingest` | `X-FCT-Key` | PA Flow 1. JSON `{ rows \| value }` or `{ $content / fileBase64 }` or raw xlsx |
| GET | `/latest` | public | Calc sync. `{ rows, ingestedAt, rowCount }` or `{ format:"xlsx", fileName, ingestedAt }` |
| GET | `/latest.xlsx` | public | Workbook bytes when the last ingest was a file |
| POST | `/push-row` | public | Calc → PA Flow 2. Body may include `pushUrl` from Settings |
| POST | `/send-sms` | public | `{ to, driver, origin, dest, appt, po }`. Twilio if configured |
| GET | `/health` | public | Sanity |

Ingest JSON shapes Power Automate actually sends:

```json
{ "rows": [ { "time":"", "po":"", "driver":"", "origin":"", "fb":"", "commodity":"", "truck":"", "status":"", "extra":"" } ] }
```

```json
{ "value": [ /* Excel List rows present in a table */ ] }
```

```json
{ "$content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "$content": "<base64>" }
```

## Tests

```bash
npm test
```

No network, no Twilio, no secrets. SMS-missing-env asserts `"SMS not configured"`.
