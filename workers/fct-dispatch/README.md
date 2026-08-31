# fct-dispatch Worker

Production: `https://fct-dispatch.jamesgrunsky.workers.dev`

Receives the dispatch log and stores `{ rows, ingestedAt, rowCount }` in KV
for `GET /latest`. The calc parses those rows with `parseDispatchRows`.

**Office Script JSON still works.** Power Automate Flow 1 can POST the xlsx
from OneDrive Get file content (no Office Script on the hourly recopy).

## Deploy

```bash
cd workers/fct-dispatch
npm test
npx wrangler deploy
```

`DISPATCH` KV and `INGEST_KEY` already exist on the live worker. Deploy
updates the script only. Do not put the ingest key in git, logs, or
responses. `GET /latest` stays public. CORS is `*`.

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

The PA `$content` envelope is taken from the raw body **before** a full
`JSON.parse`, so a huge or slightly invalid envelope (unescaped newlines
in `$content`, UTF-16, latin1 PK bytes in `$content`) still returns 200
and updates `GET /latest`. JSON row posts and raw xlsx bytes are unchanged.

Invalid JSON with no `$content` / xlsx still returns HTTP 400 `{"error":"bad_json"}`.

## Tests

```bash
npm test
```

No network, no secrets. Covers JSON rows, `$content` base64 xlsx, raw
bytes, and bad JSON.
