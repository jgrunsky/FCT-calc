# fct-verizon Worker

Cloudflare Worker behind `https://fct-verizon.jamesgrunsky.workers.dev`.
Serves Verizon Reveal GPS (`/latest`, `/miles`, `/signals`, …) and, as of
v0.14, company-wide calc settings at `/canonical-settings`.

**Direction of sync (v2.1.27):** operator Settings edits **push** to KV.
The app does **not** silent-overwrite local diesel/MPG on boot. A banner
offers tap-to-pull; dismiss keeps this device. v2.1.25 auto-apply wrote
EIA CA retail ($6.919) over live FCT diesel ($4.50) and understated MTD.

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
# fuelPricePerGal should be 4.50 (QBO), NOT 6.919 (EIA)
# eiaCaRetailFuelPricePerGal 6.919 is reference-only

curl -s -X POST https://fct-verizon.jamesgrunsky.workers.dev/canonical-settings \
  -H 'content-type: application/json' \
  -d '{"fuelPricePerGal":4.50,"fleetAvgMPG":6.0,"defaultDriverRate":22.28,"source":"smoke-test"}'
# {"ok": true, ...}

curl -s https://fct-verizon.jamesgrunsky.workers.dev/health
curl -s https://fct-verizon.jamesgrunsky.workers.dev/latest | head -c 200
```

If Pages ships first, Settings save still works on the device; the “couldn’t
update the other one” toast fires until this worker is deployed. `/latest`,
`/miles`, and `/signals` are unchanged.

## `/canonical-settings`

| Method | Behavior |
|--------|----------|
| `GET` | Read KV key `canonical_settings`. If missing/invalid, return QBO-aligned defaults (diesel **$4.50**, MPG **6.0**, driver rate $22.28) plus `eiaCaRetailFuelPricePerGal` 6.919 as a labeled reference. |
| `POST` / `PUT` | Merge JSON onto current (or defaults), write KV. Last write wins. Operator edit is the source of truth. |
| `OPTIONS` | CORS preflight. `Access-Control-Allow-Origin: *` |

Partial bodies are fine (`{"fuelPricePerGal": 4.50}` keeps MPG and rate).

v1 has no auth — same as `/dispatch-log`. Anyone who can hit the URL can
overwrite the company numbers. Fine for an operator-only app; add a shared
secret later if this URL leaks.

## What this deploy must not break

`/health`, `/latest`, `/miles`, `/miles-real`, `/signals`, `/calibration`,
`/dispatch-log` (POST), and the `/debug/*` probes. Cron `*/10 * * * *`
still refreshes the Verizon snapshot into KV.
