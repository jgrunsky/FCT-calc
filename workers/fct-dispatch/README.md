# fct-dispatch Worker

Production worker: `https://fct-dispatch.jamesgrunsky.workers.dev`

The phone does not call that host. iOS Safe Browsing blocks `*.workers.dev`,
which left the calc on a red Worker offline pill. FCT Calc loads
`/api/dispatch/latest` on `https://fct-calc.pages.dev`, and a Pages Function
forwards GET `/health` and GET `/latest` here.

**POST `/ingest` stays on this worker URL.** Power Automate / Excel Automate
must keep posting to `https://fct-dispatch.jamesgrunsky.workers.dev/ingest`.
The Pages path returns 404 for `/ingest` and does not forward it.

Receives the dispatch log and stores `{ rows, ingestedAt, rowCount }` in KV
for `GET /latest`. The calc parses those rows with `parseDispatchRows`.

**Office Script JSON still works.** Power Automate Flow 1 can POST the xlsx
from OneDrive Get file content (no Office Script on the hourly recopy).

## Deploy the worker

Only when the ingest/latest script itself changes:

```bash
cd workers/fct-dispatch
npm test
npx wrangler deploy
```

`DISPATCH` KV and `INGEST_KEY` already exist on the live worker. Deploy
updates the script only. Do not put the ingest key in git, logs, or
responses. `GET /latest` stays public. CORS is `*`.

The v2.1.54 phone fix does **not** need a worker deploy. Ingest is unchanged.

## Deploy the Pages proxy (phone sync)

From the repo root, after the calc and `functions/` are on the branch you
want live:

```bash
npx wrangler pages deploy . --project-name fct-calc
```

That publishes `index.html` and the Pages Functions under `functions/api/`.
Confirm from a machine (not the phone):

```bash
curl -s https://fct-calc.pages.dev/api/dispatch/health
curl -s https://fct-calc.pages.dev/api/dispatch/latest | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://fct-calc.pages.dev/api/dispatch/ingest
# expect 404 — ingest is not proxied

curl -s -o /dev/null -w '%{http_code}\n' -X POST https://fct-dispatch.jamesgrunsky.workers.dev/ingest
# expect 401 without X-FCT-Key — Power Automate path still exists
```

On the phone, open FCT Calc and reload when the new-build banner shows
`fct-calc-v2.1.54-same-origin-sync`, then tap Refresh. The pill should
leave Worker offline. The header version is the cache-bust token.

## Endpoints

| Method | Path | Auth | Role |
|--------|------|------|------|
| GET | `/latest` | public | `{ rows, ingestedAt, rowCount }` |
| GET | `/health` | public | `{ ok, ts }` |
| POST | `/ingest` | `X-FCT-Key` | Store latest snapshot |

## `POST /ingest` bodies

1. JSON `{ "rows": [ { time, po, driver, origin, fb, commodity, truck, status, extra }, … ] }` or `{ "value": [ … ] }`
2. OneDrive / Power Automate envelope:
   `{ "$content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "$content": "<base64>" }`
   also `fileContent` or `body` holding that envelope or the base64 string
3. Raw xlsx bytes (PK zip magic), any Content-Type

xlsx is read with SheetJS the same way the calc import path does. Sheet
`2026` of `2026 FCT Dispatch Log.xlsx` (else the first sheet) becomes the
row objects above, including date banners and blank spacers.

Invalid JSON still returns HTTP 400 `{"error":"bad_json"}`.

## Tests

```bash
npm test
```

No network, no secrets. Covers JSON rows, `$content` base64 xlsx, raw
bytes, and bad JSON.
