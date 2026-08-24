import { strict as assert } from "node:assert";
import {
  CANONICAL_SETTINGS_DEFAULTS,
  KV_KEY_CANONICAL_SETTINGS,
  loadCanonicalSettings,
  mergeCanonicalSettings,
  handleCanonicalSettingsRequest
} from "./canonical-settings.js";

class MockKV {
  constructor(seed) {
    this.map = new Map();
    if (seed) this.map.set(KV_KEY_CANONICAL_SETTINGS, JSON.stringify(seed));
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
}

function envWith(kv) {
  return { FCT_VERIZON: kv };
}

// --- merge ---
{
  const r = mergeCanonicalSettings(CANONICAL_SETTINGS_DEFAULTS, {
    fuelPricePerGal: 7.25,
    fleetAvgMPG: 6.1,
    defaultDriverRate: 23
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.fuelPricePerGal, 7.25);
  assert.equal(r.value.fleetAvgMPG, 6.1);
  assert.equal(r.value.defaultDriverRate, 23);
  assert.equal(r.value.subFlatRate, 150);
  assert.ok(r.value.computedAt);
  assert.equal(r.value.updatedAt, r.value.computedAt);
}

{
  const r = mergeCanonicalSettings(CANONICAL_SETTINGS_DEFAULTS, { fuelPricePerGal: -1 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.error.field, "fuelPricePerGal");
}

{
  const r = mergeCanonicalSettings(CANONICAL_SETTINGS_DEFAULTS, null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
}

{
  const r = mergeCanonicalSettings(
    { ...CANONICAL_SETTINGS_DEFAULTS, fuelPricePerGal: 7 },
    { fleetAvgMPG: 5.5 }
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.fuelPricePerGal, 7, "partial write must keep other fields");
  assert.equal(r.value.fleetAvgMPG, 5.5);
}

// --- load fallback ---
{
  const loaded = await loadCanonicalSettings({});
  assert.equal(loaded.fuelPricePerGal, 4.50);
}
{
  const loaded = await loadCanonicalSettings(envWith(new MockKV({ fuelPricePerGal: 6.5 })));
  assert.equal(loaded.fuelPricePerGal, 6.5);
  assert.equal(loaded.fleetAvgMPG, 6.0, "missing KV fields fall back to QBO-aligned defaults");
  assert.equal(loaded.eiaCaRetailFuelPricePerGal, 6.919, "EIA reference is not live fuel");
}

// --- HTTP GET fallback ---
{
  const res = await handleCanonicalSettingsRequest(
    new Request("https://example/canonical-settings", { method: "GET" }),
    {}
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.fuelPricePerGal, 4.50);
  assert.equal(body.fleetAvgMPG, 6.0);
  assert.equal(body.eiaCaRetailFuelPricePerGal, 6.919);
  assert.ok(body.servedAt);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
}

// --- HTTP PUT then GET ---
{
  const kv = new MockKV();
  const env = envWith(kv);
  const put = await handleCanonicalSettingsRequest(
    new Request("https://example/canonical-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fuelPricePerGal: 7.01,
        fleetAvgMPG: 6.4,
        defaultDriverRate: 22.5,
        source: "fct-calc"
      })
    }),
    env
  );
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.equal(saved.ok, true);
  assert.equal(saved.fuelPricePerGal, 7.01);
  assert.equal(saved.updatedFrom, "fct-calc");
  assert.equal(saved.eiaCaRetailFuelPricePerGal, 6.919, "operator push must not wipe EIA reference");

  const get = await handleCanonicalSettingsRequest(
    new Request("https://example/canonical-settings"),
    env
  );
  const got = await get.json();
  assert.equal(got.fuelPricePerGal, 7.01);
  assert.equal(got.fleetAvgMPG, 6.4);
  assert.equal(got.defaultDriverRate, 22.5);
}

// --- POST works the same as PUT ---
{
  const kv = new MockKV();
  const env = envWith(kv);
  const post = await handleCanonicalSettingsRequest(
    new Request("https://example/canonical-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fuelPricePerGal: 8 })
    }),
    env
  );
  assert.equal(post.status, 200);
  const got = await post.json();
  assert.equal(got.fuelPricePerGal, 8);
}

// --- OPTIONS / 405 ---
{
  const res = await handleCanonicalSettingsRequest(
    new Request("https://example/canonical-settings", { method: "OPTIONS" }),
    {}
  );
  assert.equal(res.status, 204);
  assert.ok(res.headers.get("access-control-allow-methods").includes("PUT"));
}
{
  const res = await handleCanonicalSettingsRequest(
    new Request("https://example/canonical-settings", { method: "DELETE" }),
    envWith(new MockKV())
  );
  assert.equal(res.status, 405);
}

console.log("canonical-settings tests passed");
