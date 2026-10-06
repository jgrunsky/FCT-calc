import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DISPATCH_UPSTREAM,
  VERIZON_UPSTREAM,
  upstreamPath,
  dispatchAllowed,
  verizonAllowed,
  proxyWorkerRequest,
  DISPATCH_PROXY,
  VERIZON_PROXY,
} from './functions/_lib/same-origin-proxy.js';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');

assert.equal(upstreamPath('/api/dispatch/latest', '/api/dispatch'), '/latest');
assert.equal(upstreamPath('/api/dispatch/latest/', '/api/dispatch'), '/latest');
assert.equal(upstreamPath('/api/dispatch', '/api/dispatch'), '/');
assert.equal(upstreamPath('/api/verizon/miles/range', '/api/verizon'), '/miles/range');
assert.equal(upstreamPath('/api/verizon/miles-today', '/api/verizon'), '/miles-today');
assert.equal(upstreamPath('/api/dispatch/../ingest', '/api/dispatch'), null);
assert.equal(upstreamPath('/api/other/latest', '/api/dispatch'), null);

assert.equal(dispatchAllowed('GET', '/latest'), true);
assert.equal(dispatchAllowed('GET', '/health'), true);
assert.equal(dispatchAllowed('POST', '/ingest'), false);
assert.equal(dispatchAllowed('POST', '/latest'), false);
assert.equal(dispatchAllowed('GET', '/debug/token'), false);

assert.equal(verizonAllowed('GET', '/latest'), true);
assert.equal(verizonAllowed('GET', '/miles-real'), true);
assert.equal(verizonAllowed('GET', '/signals'), true);
assert.equal(verizonAllowed('GET', '/calibration'), true);
assert.equal(verizonAllowed('POST', '/dispatch-log'), true);
assert.equal(verizonAllowed('POST', '/canonical-settings'), true);
assert.equal(verizonAllowed('PUT', '/canonical-settings'), true);
assert.equal(verizonAllowed('GET', '/debug/token'), false);
assert.equal(verizonAllowed('GET', '/debug/refresh'), false);
assert.equal(verizonAllowed('POST', '/debug/refresh'), false);

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

{
  const fetchImpl = mockFetch(async () => new Response(JSON.stringify({ ok: true, rowCount: 3 }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-secret': 'nope' },
  }));
  const res = await proxyWorkerRequest(
    new Request('https://fct-calc.pages.dev/api/dispatch/latest?bust=1', {
      headers: { accept: 'application/json', cookie: 'session=1', 'x-fct-key': 'secret' },
    }),
    DISPATCH_PROXY,
    fetchImpl
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rowCount, 3);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, DISPATCH_UPSTREAM + '/latest?bust=1');
  assert.equal(fetchImpl.calls[0].init.headers.get('cookie'), null);
  assert.equal(fetchImpl.calls[0].init.headers.get('x-fct-key'), null);
  assert.equal(fetchImpl.calls[0].init.headers.get('accept'), 'application/json');
  assert.equal(res.headers.get('x-secret'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
}

{
  const fetchImpl = mockFetch(async () => new Response('nope', { status: 200 }));
  const res = await proxyWorkerRequest(
    new Request('https://fct-calc.pages.dev/api/dispatch/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fct-key': 'secret' },
      body: '{"rows":[]}',
    }),
    DISPATCH_PROXY,
    fetchImpl
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not_proxied');
  assert.equal(fetchImpl.calls.length, 0, 'POST /ingest must not be forwarded');
}

{
  const fetchImpl = mockFetch(async (_url, init) => {
    const text = new TextDecoder().decode(init.body);
    return new Response(JSON.stringify({ ok: true, echoed: JSON.parse(text) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const res = await proxyWorkerRequest(
    new Request('https://fct-calc.pages.dev/api/verizon/dispatch-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"days":[{"date":"2026-10-06","rows":[]}]}',
    }),
    VERIZON_PROXY,
    fetchImpl
  );
  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls[0].url, VERIZON_UPSTREAM + '/dispatch-log');
  const body = await res.json();
  assert.equal(body.echoed.days[0].date, '2026-10-06');
}

{
  const fetchImpl = mockFetch(async () => { throw new Error('boom'); });
  const res = await proxyWorkerRequest(
    new Request('https://fct-calc.pages.dev/api/dispatch/health'),
    DISPATCH_PROXY,
    fetchImpl
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_unreachable');
}

assert.ok(/const APP_VERSION = '2026-10-06-fct-calc-v2\.1\.54-same-origin-sync'/.test(html), 'APP_VERSION bumped');
assert.ok(/name="app-version" content="2026-10-06-fct-calc-v2\.1\.54-same-origin-sync"/.test(html), 'meta app-version bumped');
assert.ok(!/workers\.dev/i.test(html), 'the page the phone loads must not name a workers.dev host');

assert.ok(/const WORKER_URL = '\/api\/dispatch\/latest'/.test(html), 'dispatch default is same-origin');
assert.ok(/const VERIZON_WORKER_URL = '\/api\/verizon\/latest'/.test(html));
assert.ok(/const VERIZON_SIGNALS_URL = '\/api\/verizon\/signals'/.test(html));
assert.ok(/const VERIZON_MILES_URL\s+= '\/api\/verizon\/miles'/.test(html));
assert.ok(/const VERIZON_MILES_REAL_URL = '\/api\/verizon\/miles-real'/.test(html));
assert.ok(/const VERIZON_CALIBRATION_URL = '\/api\/verizon\/calibration'/.test(html));
assert.ok(/const VERIZON_DISPATCH_LOG_URL = '\/api\/verizon\/dispatch-log'/.test(html));
assert.ok(/const VERIZON_CANONICAL_SETTINGS_URL = '\/api\/verizon\/canonical-settings'/.test(html));

const blockStart = html.indexOf('/* BEGIN SAME_ORIGIN_DISPATCH_URL */');
const blockEnd = html.indexOf('/* END SAME_ORIGIN_DISPATCH_URL */');
assert.ok(blockStart >= 0 && blockEnd > blockStart, 'rewrite helper is marked for the test');
const ctx = createContext({});
runInContext(html.slice(blockStart, blockEnd), ctx);
const rewrite = (url) => ctx.preferSameOriginDispatchUrl(url);
assert.equal(rewrite(''), '/api/dispatch/latest');
assert.equal(rewrite('https://fct-dispatch.jamesgrunsky.workers.dev/latest'), '/api/dispatch/latest');
assert.equal(rewrite('https://fct-dispatch.jamesgrunsky.workers.dev/latest/'), '/api/dispatch/latest');
assert.equal(rewrite('https://FCT-DISPATCH.JAMESGRUNSKY.WORKERS.DEV/health'), '/api/dispatch/latest');
assert.equal(rewrite('/api/dispatch/latest'), '/api/dispatch/latest');
assert.equal(rewrite('https://example.com/custom-latest'), 'https://example.com/custom-latest');

assert.ok(/isoLocal\(new Date\(\)\)/.test(html), 'v2.1.53 day catch-up uses isoLocal');
assert.ok(/ageDays > 2 && has\(today\)/.test(html), 'stale filterDate older than 2 days jumps to today');
assert.ok(/v2\.1\.53-day-catchup/.test(html), 'day-catchup changelog kept');
assert.ok(/v2\.1\.54-same-origin-sync/.test(html), 'proxy changelog present');

console.log('same-origin-proxy.test.mjs: ok');
