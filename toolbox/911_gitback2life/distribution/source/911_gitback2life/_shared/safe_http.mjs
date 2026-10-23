// The toolkit's ONLY real HTTP transport. Every outbound web request goes through here, called by
// _shared/polite.mjs (which adds robots.txt, spacing, budgets and hop-by-hop redirects) or by
// redirect_inspector (which adds its own live gate). Guarantees for every single request:
//   - GET or HEAD only: the toolkit is read-only.
//   - The URL is checked before connecting (scheme, embedded credentials, port, private/internal hosts).
//   - The DNS answer is resolved once, refused if ANY address is non-public, and pinned for the connection.
//   - The connected address is re-checked.
//   - No automatic redirects (callers follow them one step at a time), no proxies, no keep-alive reuse.
//   - Response size and time are bounded.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { GuardError, isPublicAddress, makePinnedLookup, validateTarget } from './guards.mjs';

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
const defaultResolveAll = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

export function guardedRequest(target, {
  method = 'GET', headers = {}, maxBytes = DEFAULT_MAX_BYTES, truncate = false, timeoutMs = 30_000, signal,
  lookup = makePinnedLookup(defaultResolveAll),
} = {}) {
  const m = String(method).toUpperCase();
  if (!ALLOWED_METHODS.has(m)) return Promise.reject(new GuardError(`method ${m} refused: the toolkit is read-only (GET/HEAD only)`));
  let url;
  try { url = validateTarget(String(target?.href ?? target)); } catch (e) { return Promise.reject(e); }
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: m, agent: false, lookup, maxHeaderSize: 32 * 1024, timeout: timeoutMs, headers }, (res) => {
      const remote = res.socket?.remoteAddress ?? null;
      if (remote && !isPublicAddress(remote)) { res.destroy(); reject(new GuardError(`connected to non-public address ${remote}`)); return; }
      const chunks = [];
      let size = 0;
      let truncated = false;
      res.on('data', (c) => {
        if (truncated) return;
        size += c.length;
        if (size > maxBytes) {
          if (!truncate) { res.destroy(); reject(new GuardError(`response larger than ${maxBytes} bytes; stopped reading`)); return; }
          chunks.push(c.subarray(0, c.length - (size - maxBytes)));
          truncated = true;
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('close', () => resolve({ url: url.href, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), remoteAddress: remote, truncated }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.end();
  });
}

/** Wrap a guardedRequest result as a standard fetch Response (status, headers, text(), json(), url). */
export function toResponse({ url, status, headers, body }) {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers ?? {})) for (const x of [].concat(v)) h.append(k, String(x));
  const res = new Response(NULL_BODY_STATUS.has(status) ? null : body, { status, headers: h });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

/**
 * Wrapper over guardedRequest with the same interface as the built-in fetch function,, used as the default transport by politeFetch.
 * Refuses automatic redirects: callers must pass redirect: 'manual' and check every hop themselves.
 * Extra init fields: maxBytes, truncate.
 */
export async function guardedFetch(input, init = {}) {
  if (init.redirect !== 'manual') throw new GuardError('automatic redirects are refused; follow redirects hop by hop (redirect: "manual")');
  const r = await guardedRequest(String(input?.href ?? input?.url ?? input), {
    method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)),
    maxBytes: init.maxBytes, truncate: init.truncate, signal: init.signal,
  });
  return toResponse(r);
}
