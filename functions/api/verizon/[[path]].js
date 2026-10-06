import { proxyWorkerRequest, VERIZON_PROXY } from '../../_lib/same-origin-proxy.js';

export function onRequest(context) {
  return proxyWorkerRequest(context.request, VERIZON_PROXY);
}
