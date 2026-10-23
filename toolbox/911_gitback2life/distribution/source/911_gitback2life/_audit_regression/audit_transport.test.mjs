// Adapted copy of the audit's mocked-transport suite (original preserved at
// D:\CRTS apps\MY_tools\gitback2life_audit_v2\audit_transport.mjs). Only the import path changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { guardedRequest } from '../_shared/safe_http.mjs';
// Mock the entire request object: no socket, DNS lookup or server is created.
async function simulate(options, { remote = '8.8.8.8', body = 'synthetic', timeout = false } = {}) {
  const original = https.request;
  https.request = (url, init, callback) => {
    const req = new EventEmitter(); req.destroy = (e) => req.emit('error', e);
    req.end = () => queueMicrotask(() => {
      if (timeout) { req.emit('timeout'); return; }
      const res = new EventEmitter(); res.socket = { remoteAddress: remote }; res.statusCode = 200; res.headers = {};
      res.destroy = () => { res.destroyed = true; queueMicrotask(() => res.emit('close')); };
      callback(res); if (!res.destroyed) { res.emit('data', Buffer.from(body)); res.emit('close'); }
    }); return req;
  };
  try { return await guardedRequest('https://alpha.example/', options); } finally { https.request = original; }
}
test('mocked successful guarded transport response', async () => { const r = await simulate({}); assert.equal(r.status, 200); assert.equal(r.body.toString(), 'synthetic'); });
test('mocked connected private peer is rejected', async () => { await assert.rejects(simulate({}, { remote: '::1' }), /non-public/); });
test('mocked response byte limit rejects oversize', async () => { await assert.rejects(simulate({ maxBytes: 2 }), /larger than/); });
test('mocked truncation limits retained bytes', async () => { const r = await simulate({ maxBytes: 2, truncate: true }); assert.equal(r.body.length, 2); assert.equal(r.truncated, true); });
test('mocked idle timeout fails', async () => { await assert.rejects(simulate({ timeoutMs: 1 }, { timeout: true }), /timeout/); });
