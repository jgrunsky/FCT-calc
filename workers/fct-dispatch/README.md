# fct-dispatch Worker

Production: `https://fct-dispatch.jamesgrunsky.workers.dev`

Power Automate is the Excel two-way bridge. **Microsoft 365 Personal** on
`jamesgrunsky@hotmail.com` — consumer OneDrive / Excel Online on OneDrive,
not a work tenant and not Excel Online (Business) / SharePoint-only.
This Worker is the hop the calc talks to — James builds the two flows in
Microsoft (no flow designer in the HTML app). Use **OneDrive (personal)**
and Excel-on-OneDrive connectors, not OneDrive for Business.

**HTTP in Power Automate is a premium connector.** The webhook design
stays (`POST /ingest`, `POST /push-row`). If the HTTP action is gated,
do **not** buy Premium just to feed the board:

- Keep the dispatch xlsx in consumer OneDrive.
- Use the calc’s existing **Import from OneDrive** share URL (`dispUrl` /
  `lastUrl` on Today). That standard path still parses with the same
  importer.
- Leave the Flow 2 URL empty — assignment still records in the app.
- Download today’s sheet remains a **manual backup**, not the live path.

**Flow 1 — Excel → app** (when HTTP is available). OneDrive file-modified
(or a scheduled Get file content on the personal OneDrive connector)
POSTs the dispatch log here. JSON rows *or* xlsx bytes. Header `X-FCT-Key`
= the `INGEST_KEY` secret (paste the same value into PA). The calc GETs
`/latest` (or `/latest.xlsx`) and runs the same importer it uses for a
dropped file.

**Flow 2 — app → Excel** (premium HTTP trigger). Settings holds the HTTP
trigger URL. On Send dispatch / assign, the calc POSTs `{ date, po,
origin, dest, driver, truck, status, … }` to this Worker’s `/push-row`,
which forwards to that URL so PA can Update a row. Empty URL → skip,
assignment still records in the app.

SMS is **optional**. Twilio was not set up (Hotmail, no company email).
Missing `TWILIO_*` secrets return `"SMS not configured"` and do **not**
fail the assignment. Never commit secrets. CI does not send real texts.

## Deploy

```bash
cd workers/fct-dispatch
npx wrangler deploy
npx wrangler secret put INGEST_KEY
# optional SMS — leave unset; assignment still works
# npx wrangler secret put TWILIO_ACCOUNT_SID
# npx wrangler secret put TWILIO_AUTH_TOKEN
# npx wrangler secret put TWILIO_FROM
```

`DISPATCH` KV is already bound. `wrangler deploy` updates the script only.

## Endpoints

| Method | Path | Auth | Role |
|--------|------|------|------|
| POST | `/ingest` | `X-FCT-Key` | PA Flow 1. JSON `{ rows \| value }` or `{ $content / fileBase64 }` or raw xlsx |
| GET | `/latest` | public | Calc sync. `{ rows, ingestedAt, rowCount }` or `{ format:"xlsx", fileName, ingestedAt }` |
| GET | `/latest.xlsx` | public | Workbook bytes when the last ingest was a file |
| POST | `/push-row` | public | Calc → PA Flow 2. Body may include `pushUrl` from Settings |
| POST | `/send-sms` | public | `{ to, driver, origin, dest, appt, po }`. Optional; `"SMS not configured"` if secrets missing |
| GET | `/health` | public | Sanity |

Ingest JSON shapes Power Automate actually sends (personal OneDrive Get
file content uses the same `$content` envelope):

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
