import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanDir, scanText } from './fetcher_review.mjs';

test('scan finds redirect-follow, fetch, timeout, host comparison and body reads in the fixture', () => {
  const hits = scanDir(fileURLToPath(new URL('./fixtures', import.meta.url)));
  const rules = new Set(hits.map((h) => h.rule));
  for (const r of ['redirect_follow', 'fetch_call', 'timeout', 'host_check', 'body_read', 'url_parse']) assert.ok(rules.has(r), r);
  assert.ok(!rules.has('ip_check'), 'fixture has no private-IP check, so that category must come back empty');
  assert.ok(hits.every((h) => h.file === 'sample_fetch.ts'));
});

test('scanText reports line numbers', () => {
  const hits = scanText("a\nfetch(u, { redirect: 'manual' })", 'x.ts');
  assert.ok(hits.some((h) => h.rule === 'redirect_manual' && h.line === 2));
});
