/**
 * Same-origin Pages proxy for FCT Calc.
 *
 * iOS/Safari Safe Browsing blocks browser fetches to *.workers.dev, so the
 * phone must call fct-calc.pages.dev only. These routes run on Pages and
 * forward to the existing workers. Server-side fetch is not subject to that
 * phishing filter.
 *
 * POST /ingest is intentionally not forwarded. Power Automate / Excel
 * Automate keep posting to the dispatch worker URL directly.
 * Verizon /debug/* is not forwarded (token and refresh probes).
 */

export const DISPATCH_UPSTREAM = 'https://fct-dispatch.jamesgrunsky.workers.dev';
export const VERIZON_UPSTREAM = 'https://fct-verizon.jamesgrunsky.workers.dev';

export const DISPATCH_PREFIX = '/api/dispatch';
export const VERIZON_PREFIX = '/api/verizon';

const DISPATCH_GET = new Set(['/', '/health', '/latest']);

const VERIZON_GET = new Set([
  '/',
  '/health',
  '/latest',
  '/signals',
  '/miles',
  '/miles-today',
  '/miles-yesterday',
  '/miles-real',
  '/miles/range',
  '/calibration',
  '/canonical-settings',
]);

const VERIZON_WRITE = new Set(['/dispatch-log', '/canonical-settings']);

export function dispatchAllowed(method, path) {
  const m = String(method || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return DISPATCH_GET.has(path);
  return false;
}

export function verizonAllowed(method, path) {
  const m = String(method || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return VERIZON_GET.has(path);
  if (m === 'POST' && VERIZON_WRITE.has(path)) return true;
  if ((m === 'PUT') && path === '/canonical-settings') return true;
  return false;
}

export const DISPATCH_PROXY = {
  upstream: DISPATCH_UPSTREAM,
  prefix: DISPATCH_PREFIX,
  allow: dispatchAllowed,
};

export const VERIZON_PROXY = {
  upstream: VERIZON_UPSTREAM,
  prefix: VERIZON_PREFIX,
  allow: verizonAllowed,
};

/**
 * Map a Pages pathname to the upstream path.
 * Returns null when the pathname is outside the prefix or tries to traverse.
 */
export function upstreamPath(pathname, prefix) {
  if (typeof pathname !== 'string' || typeof prefix !== 'string' || !prefix.startsWith('/')) return null;
  let p = pathname;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p !== prefix && !p.startsWith(prefix + '/')) return null;
  const rest = p === prefix ? '/' : p.slice(prefix.length);
  if (!rest.startsWith('/')) return null;
  let decoded;
  try { decoded = decodeURIComponent(rest); } catch (_) { return null; }
  if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) return null;
  return rest;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, POST, PUT, OPTIONS',
      'access-control-allow-headers': 'content-type, accept',
      'access-control-max-age': '86400',
      'cache-control': 'no-store',
    },
  });
}

/**
 * @param {Request} request
 * @param {{ upstream: string, prefix: string, allow: (method: string, path: string) => boolean }} opts
 * @param {typeof fetch} [fetchImpl]
 */
export async function proxyWorkerRequest(request, opts, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return corsPreflight();

  const path = upstreamPath(url.pathname, opts.prefix);
  if (!path || !opts.allow(request.method, path)) {
    return json({ error: 'not_proxied', method: request.method, path: path || url.pathname }, 404);
  }

  const target = new URL(path + url.search, opts.upstream);
  const headers = new Headers();
  const accept = request.headers.get('accept');
  const contentType = request.headers.get('content-type');
  if (accept) headers.set('accept', accept);
  if (contentType) headers.set('content-type', contentType);

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await doFetch(target.toString(), init);
  } catch (err) {
    return json({ error: 'upstream_unreachable', message: String(err && err.message || err) }, 502);
  }

  const outHeaders = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) outHeaders.set('content-type', ct);
  outHeaders.set('cache-control', 'no-store');
  outHeaders.set('access-control-allow-origin', '*');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}
