# fct-verizon Worker

Cloudflare Worker behind `https://fct-verizon.jamesgrunsky.workers.dev`.
Serves Verizon Reveal GPS (`/latest`, `/miles`, `/signals`, …) and, as of
v0.13, company-wide calc settings at `/canonical-settings`.

The FCT Load Profitability app (Pages: https://fct-calc.pages.dev) **pulls**
those settings on boot (v2.1.25 auto-apply) and **pushes** them when diesel,
MPG, or default driver rate is saved in Settings (v2.1.26).

## Deploy (do this before or with the Pages deploy)

Secrets (`VERIZON_APP_ID`, `VERIZON_USERNAME`, `VERIZON_PASSWORD`) and the
`FCT_VERIZON` KV binding already exist on the live worker. `wrangler deploy`
from this folder updates the script; it does not recreate those.

```bash
cd workers/fct-verizon
npx wrangler deploy
```

Confirm:

```bash
curl -s https://fct-verizon.jamesgrunsky.workers.dev/canonical-settings
# still returns fuelPricePerGal / fleetAvgMPG / defaultDriverRate

curl -s -X POST https://fct-verizon.jamesgrunsky.workers.dev/canonical-settings \
  -H 'content-type: application/json' \
  -d '{"fuelPricePerGal":6.919,"fleetAvgMPG":6.3,"defaultDriverRate":22.28,"source":"smoke-test"}'
# {"ok": true, ...}

curl -s https://fct-verizon.jamesgrunsky.workers.dev/health
curl -s https://fct-verizon.jamesgrunsky.workers.dev/latest | head -c 200
```

If Pages ships first, Settings save still works on the device; the “couldn’t
update the other one” toast fires until this worker is deployed (POST used
to 405 / no-op). `/latest`, `/miles`, and `/signals` are unchanged.

## `/canonical-settings`

| Method | Behavior |
|--------|----------|
| `GET` | Read KV key `canonical_settings`. If missing/invalid, return the shipped defaults (diesel $6.919, MPG 6.3, driver rate $22.28). |
| `POST` / `PUT` | Merge JSON onto current (or defaults), write KV. Last write wins. |
| `OPTIONS` | CORS preflight. `Access-Control-Allow-Origin: *` |

Partial bodies are fine (`{"fuelPricePerGal": 7.10}` keeps MPG and rate).

v1 has no auth — same as `/dispatch-log`. Anyone who can hit the URL can
overwrite the company numbers. Fine for an operator-only app; add a shared
secret later if this URL leaks.

## What this deploy must not break

`/health`, `/latest`, `/miles`, `/miles-real`, `/signals`, `/calibration`,
`/dispatch-log` (POST), and the `/debug/*` probes. Cron `*/10 * * * *`
still refreshes the Verizon snapshot into KV.
