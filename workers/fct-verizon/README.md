# fct-verizon Worker

Cloudflare Worker behind `https://fct-verizon.jamesgrunsky.workers.dev`.

The phone reads it through `https://fct-calc.pages.dev/api/verizon/*` (Pages
forwards `/latest`, `/signals`, `/miles`, `/miles-real`, `/calibration`,
`/dispatch-log`, and `/canonical-settings`). `/debug/*` is not forwarded.
Direct worker URLs below are for deploy checks from a machine, not from Safari.
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
update the other one” toast fires until this worker is deployed. `/miles` and
`/signals` stay truck-only: trailer GPS is not added into fleet miles or
dispatch signals, so a trailer riding with a truck does not double-count.

## Trailer GPS (v0.15)

`/latest` stamps every vehicle with `_assetClass` (`truck`, `trailer`, or
`pending`), `_gps` (`live`, `no_gps`, or `unlocated`), and `_locKey` (the
Reveal id that answered). Location lookup tries **VehicleNumber**, then
**Name**, then **VehicleId**. A number that contains `/` (trailer pairs such
as `37/38`) is not put in the URL path — the gateway rejects it — and is
sent instead as `POST /rad/v1/vehicles/locations`.

Truck miles, yard signals, and canonical fuel defaults are unchanged.
Haversine `/miles` and `/signals` skip anything that is not `_assetClass:
truck`. Trucks `1`–`24` still resolve on the same number they always used
(`Name` and `VehicleNumber` are the same string).

Deploy, then either wait for the 10-minute cron or queue one refresh:

```bash
curl -s https://fct-verizon.jamesgrunsky.workers.dev/debug/refresh
# {"ok": true, "msg": "refresh queued"}
# wait ~30s for the snapshot to finish writing
```

Verify trailers. A trailer Verizon is actually tracking has `_gps: "live"`
and a non-null `_location`. A trailer that exists on the account but has
not reported a fix stays on the list with `_location: null` and `_gps` of
`no_gps` or `unlocated` — the Fleet tab shows that as “no GPS yet”.

```bash
curl -s https://fct-verizon.jamesgrunsky.workers.dev/latest \
  | jq '{version:.workerVersion, assets:.assetSummary,
        trailers:[.vehicles[]
          | select(._assetClass=="trailer")
          | {Name, VehicleNumber, _gps, _locStatus, _locKey, _locVia,
             lat: ._location.Latitude, lng: ._location.Longitude}]}'

# Trucks 1–24 must still have coordinates. This count should stay in the
# low twenties (truck 5 is not on the account as of 2026-09-23).
curl -s https://fct-verizon.jamesgrunsky.workers.dev/latest \
  | jq '[.vehicles[]
        | select(._assetClass=="truck" and (._location.Latitude|type)=="number")]
        | length'

curl -s https://fct-verizon.jamesgrunsky.workers.dev/canonical-settings
# fuelPricePerGal should still be 4.50 (QBO), NOT 6.919 (EIA)
```

`pending` rows are tracker serials Verizon has not given a display name yet
(`2400…_20260821T21:51:58`). They are not pins until a location comes back.

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
