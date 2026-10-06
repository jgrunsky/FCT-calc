import { proxyWorkerRequest, DISPATCH_PROXY } from '../../_lib/same-origin-proxy.js';

export function onRequest(context) {
  return proxyWorkerRequest(context.request, DISPATCH_PROXY);
}
