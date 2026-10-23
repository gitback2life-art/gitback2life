// Offline tests for the shared HTTP transport. The network guard is preloaded, so any request that got as far
// as opening a connection fails with OFFLINE_NETWORK_BLOCKED; refusals must happen BEFORE that, with GUARD_BLOCKED.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHop } from './guards.mjs';
import { guardedFetch, guardedRequest, toResponse } from './safe_http.mjs';

test('only GET and HEAD are allowed; other methods are refused before any connection', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    await assert.rejects(guardedRequest('https://www.example.org/', { method }), { code: 'GUARD_BLOCKED' }, method);
  }
});

test('private, internal, credentialed and odd-port URLs are refused before any connection', async () => {
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.5/',
    'http://localhost/', 'https://user:pw@example.org/', 'https://example.org:8443/', 'file:///etc/passwd', 'http://0x7f.1/']) {
    await assert.rejects(guardedRequest(url), { code: 'GUARD_BLOCKED' }, url);
  }
});

test('a valid public URL only gets as far as the connection step (blocked here by the offline guard)', async () => {
  await assert.rejects(guardedRequest('https://www.example.org/'), (e) => /OFFLINE_NETWORK_BLOCKED/.test(e.message));
});

test('guardedFetch refuses automatic redirects outright', async () => {
  await assert.rejects(guardedFetch('https://www.example.org/'), /automatic redirects are refused/);
  await assert.rejects(guardedFetch('https://www.example.org/', { redirect: 'follow' }), /automatic redirects are refused/);
});

test('toResponse builds a normal fetch Response with url, repeated headers, and empty-body statuses', async () => {
  const r = toResponse({ url: 'https://a.example/x', status: 200, headers: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] }, body: Buffer.from('{"ok":true}') });
  assert.equal(r.url, 'https://a.example/x');
  assert.deepEqual(await r.json(), { ok: true });
  assert.match(r.headers.get('set-cookie'), /a=1.*b=2/);
  assert.equal(toResponse({ url: 'u', status: 304, headers: {}, body: Buffer.alloc(0) }).status, 304);
  assert.equal(toResponse({ url: 'u', status: 302, headers: { location: '/next' }, body: Buffer.alloc(0) }).headers.get('location'), '/next');
});

test('checkHop: validates the destination and refuses https → http downgrades', () => {
  const https = new URL('https://a.example/');
  assert.equal(checkHop(https, new URL('https://b.example/p')).href, 'https://b.example/p');
  assert.equal(checkHop(new URL('http://a.example/'), new URL('https://b.example/')).protocol, 'https:', 'upgrades are fine');
  assert.throws(() => checkHop(https, new URL('http://a.example/')), /https to http refused/);
  assert.throws(() => checkHop(https, new URL('https://192.168.1.1/')), { code: 'GUARD_BLOCKED' });
  assert.throws(() => checkHop(null, 'ftp://a.example/'), { code: 'GUARD_BLOCKED' });
});
