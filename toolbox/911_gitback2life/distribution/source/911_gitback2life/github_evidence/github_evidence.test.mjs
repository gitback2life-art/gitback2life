import assert from 'node:assert/strict';
import { test } from 'node:test';
import { excerpt, ghGet, repoAndId } from './github_evidence.mjs';

const fakeFetch = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init.method });
  return new Response('{}', { status: 200, headers: { 'x-ratelimit-remaining': '59' } });
};

test('ghGet refuses any host other than GitHub API/codeload', async () => {
  const calls = [];
  await assert.rejects(ghGet('https://evil.example/repos/x', { fetchImpl: fakeFetch(calls) }), /blocked host/);
  await assert.rejects(ghGet('http://api.github.com/repos/x', { fetchImpl: fakeFetch(calls) }), /blocked host/);
  assert.equal(calls.length, 0, 'nothing was sent');
});

test('ghGet only ever uses GET', async () => {
  const calls = [];
  await ghGet('https://api.github.com/repos/o/r', { fetchImpl: fakeFetch(calls) });
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
});

test('repoAndId accepts owner/repo + id or a full URL', () => {
  assert.deepEqual(repoAndId(['o/r', '1'], 'issues'), ['o/r', '1']);
  assert.deepEqual(repoAndId(['https://github.com/maintainer-handle-redacted/nyc-animal-rescue/actions/runs/37332890503'], 'actions/runs'),
    ['maintainer-handle-redacted/nyc-animal-rescue', '37332890503']);
  assert.throws(() => repoAndId(['o/r', 'abc'], 'issues'));
});

test('excerpt keeps only matching lines with context, and redacts secrets', () => {
  const log = ['setup', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'flagged 58 of 311', 'safety valve tripped', 'done'].join('\n');
  const rows = excerpt(log, 'flagged', { context: 1 });
  assert.deepEqual(rows.map((r) => r.n), [2, 3, 4]);
  assert.match(rows[0].text, /REDACTED/);
});

test('excerpt caps output length', () => {
  const big = Array.from({ length: 500 }, (_, i) => `match ${i}`).join('\n');
  assert.equal(excerpt(big, 'match', { maxLines: 10 }).length, 10);
});

test('GITHUB_TOKEN: only fine-grained tokens are used; others are refused before any request, and never echoed', async () => {
  const saved = process.env.GITHUB_TOKEN;
  const synthetic = { classic: 'ghp_' + 'A'.repeat(36), oauth: 'gho_' + 'B'.repeat(36), junk: 'not-a-token', fine: 'github_pat_' + 'C'.repeat(60) };
  try {
    for (const kind of ['classic', 'oauth', 'junk']) {
      process.env.GITHUB_TOKEN = synthetic[kind];
      let calls = 0;
      const err = await ghGet('https://api.github.com/repos/o/r', { fetchImpl: async () => { calls++; return new Response('{}'); } }).catch((e) => e);
      assert.ok(err instanceof Error, kind);
      assert.match(err.message, /Only fine-grained, read-only tokens/, kind);
      assert.equal(err.message.includes(synthetic[kind]), false, `${kind}: the token is never echoed`);
      assert.equal(calls, 0, `${kind}: nothing was sent`);
    }
    process.env.GITHUB_TOKEN = synthetic.fine;
    let auth = null;
    await ghGet('https://api.github.com/repos/o/r', { fetchImpl: async (u, init) => { auth = init.headers.Authorization; return new Response('{}', { status: 200 }); } });
    assert.equal(auth, `Bearer ${synthetic.fine}`, 'a fine-grained token is used');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved;
  }
});