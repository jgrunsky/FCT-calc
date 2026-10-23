import { proxyWorkerRequest, VERIZON_PROXY } from '../../_lib/same-origin-proxy.js';

export function onRequest(context) {
  return proxyWorkerRequest(context.request, VERIZON_PROXY, undefined, context.env && context.env.WORKER_READ_KEY);
}
