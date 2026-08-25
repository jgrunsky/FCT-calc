# fct-dispatch Worker

Production: `https://fct-dispatch.jamesgrunsky.workers.dev`

**Live path (2026-08-25):** the Worker FETCHes the work OneDrive
Anyone-can-edit share **server-side** and stores it as `/latest.xlsx`
(same as Flow 1 ingest). The calc GETs `/latest` then `/latest.xlsx` and
parses with the same importer as a dropped file. No Microsoft login in
the browser. CORS is this Worker’s problem.

Share (Anyone can edit) — `2026 FCT Dispatch Log.xlsx`, sheet `2026`,
account `JamesGrunsky@FrenchCampTransport.onmicrosoft.com`:

`https://frenchcamptransport-my.sharepoint.com/:x:/g/personal/jamesgrunsky_frenchcamptransport_onmicrosoft_com/IQBGRbC6973TRowZbmxEeoQEAS6NSIu-Zazhwpp9Pu5BitI?e=coV1OH`

Verified: unauthenticated GET with `?download=1` follows to
`.../Documents/2026 FCT Dispatch Log.xlsx?ga=1` **only if** the Worker
keeps `FedAuth` from the first SharePoint 302 (Workers `fetch` does not).
Without that cookie the same URL hits `login.microsoftonline.com`. Graph
`/shares` is 401 without an app token — not used. No Power Automate
Premium (HTTP was not purchased).

Flow 2 (`paPushUrl`) stays **empty** — Excel write-back skipped.
Download today’s sheet is a **manual backup**. Browser **Import from
OneDrive** stays as a fallback (the SharePoint anyone-link CORS-fails in
the page; that is expected).

SMS is **optional**. Twilio was not set up (Hotmail, no company email).

## Deploy

```bash
cd workers/fct-dispatch
npx wrangler deploy
```

`DISPATCH` KV is already bound. Cron `*/2 * * * *` refreshes the share.
`GET /latest` also pulls if the last pull is older than 90s.

Do not put secrets in git. SMS stays off until provider env vars exist.

## Endpoints

| Method | Path | Auth | Role |
|--------|------|------|------|
| GET | `/latest` | public | Pull share if stale, then `{ format:"xlsx", fileName, ingestedAt }` |
| GET | `/latest.xlsx` | public | Workbook bytes |
| GET | `/health` | public | `{ ok, sharePull }` |
| POST | `/ingest` | `X-FCT-Key` | Optional Flow 1. JSON or xlsx |
| POST | `/push-row` | public | Flow 2 hop. Empty URL → skip |
| POST | `/send-sms` | public | Optional; `"SMS not configured"` if secrets missing |

## Tests

```bash
npm test
```

No network, no Twilio, no secrets. Share tests mock redirects + FedAuth.
