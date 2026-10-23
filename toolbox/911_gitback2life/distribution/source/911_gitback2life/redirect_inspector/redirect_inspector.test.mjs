import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPublicAddress, makePinnedLookup, validateTarget } from '../_shared/guards.mjs';
import { inspectChain, liveGate, makeRobotsCheck } from './redirect_inspector.mjs';
import { ALLOW_ALL, parseRobots } from '../_shared/robots.mjs';

// Offline stand-ins: a robots check that allows everything, and one built from a fixed robots.txt per origin.
const allowAll = async () => ({ allowed: true, rule: null, basis: 'test', crawlDelay: null });
const robotsFrom = (byOrigin) => makeRobotsCheck({
  cache: (key, fn) => fn(),
  fetcher: async (url) => ({ policy: byOrigin[url.origin] ? parseRobots(byOrigin[url.origin]) : ALLOW_ALL, basis: 'test robots.txt' }),
});
const chain = (url, opts) => inspectChain(url, { robots: allowAll, ...opts });
const ISOLATED = { isolated: true, reasons: [] };

test('non-public IPv4 ranges are refused', () => {
  for (const a of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255']) assert.equal(isPublicAddress(a), false, a);
  for (const a of ['8.8.8.8', '1.1.1.1', '93.184.215.14']) assert.equal(isPublicAddress(a), true, a);
});

test('non-public IPv6 ranges, mapped IPv4 and zone IDs are refused', () => {
  for (const a of ['::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '64:ff9b::7f00:1', 'fc00::1', 'fd12::1',
    'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1', '2002:7f00:1::1', '2001:0::1']) assert.equal(isPublicAddress(a), false, a);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('not-an-ip'), false);
});

test('validateTarget rejects bad schemes, credentials, ports and internal hosts', () => {
  for (const bad of ['file:///etc/passwd', 'ftp://example.org/', 'javascript:alert(1)', 'https://user:pw@example.org/',
    'https://example.org:8443/', 'http://localhost/', 'http://printer.local/', 'http://intranet/', 'http://127.0.0.1/',
    'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'not a url']) {
    assert.throws(() => validateTarget(bad), { code: 'GUARD_BLOCKED' }, bad);
  }
  assert.equal(validateTarget('https://www.example.org/path').hostname, 'www.example.org');
});

test('pinned lookup refuses a hostname that resolves to any private address (DNS rebinding)', async () => {
  const lookup = makePinnedLookup(async () => [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }]);
  const err = await new Promise((r) => lookup('rebind.example', {}, (e) => r(e)));
  assert.equal(err?.code, 'GUARD_BLOCKED');
});

test('pinned lookup returns exactly the validated answer, in both callback shapes', async () => {
  const lookup = makePinnedLookup(async () => [{ address: '93.184.215.14', family: 4 }]);
  const single = await new Promise((r) => lookup('ok.example', {}, (e, a, f) => r({ e, a, f })));
  assert.deepEqual(single, { e: null, a: '93.184.215.14', f: 4 });
  const all = await new Promise((r) => lookup('ok.example', { all: true }, (e, list) => r(list)));
  assert.deepEqual(all, [{ address: '93.184.215.14', family: 4 }]);
});

const fakeTransport = (map) => async (url) => {
  const r = map[url.href];
  if (!r) throw new Error(`unexpected request to ${url.href}`);
  return r;
};

test('inspectChain records each hop and stops at the final response', async () => {
  const result = await chain('https://www.example.org/', {
    now: () => '2026-10-08T00:00:00Z',
    transport: fakeTransport({
      'https://www.example.org/': { status: 301, location: 'https://other.example.com/' },
      'https://other.example.com/': { status: 200 },
    }),
  });
  assert.equal(result.outcome, 'final_response');
  assert.equal(result.final_url, 'https://other.example.com/');
  assert.deepEqual(result.hops.map((h) => h.status), [301, 200]);
});

test('inspectChain refuses a redirect into a private address without contacting it', async () => {
  const result = await chain('https://www.example.org/', {
    transport: fakeTransport({ 'https://www.example.org/': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' } }),
  });
  assert.equal(result.outcome, 'blocked_by_guard');
  assert.equal(result.hops.length, 1);
  assert.match(result.hops[0].next_blocked, /non-public/);
});

test('inspectChain resolves relative Location headers, detects loops, and caps hops', async () => {
  const loop = await chain('https://a.example.org/', {
    transport: fakeTransport({
      'https://a.example.org/': { status: 302, location: '/b' },
      'https://a.example.org/b': { status: 302, location: 'https://a.example.org/' },
    }),
  });
  assert.equal(loop.outcome, 'loop_detected');
  let n = 0;
  const endless = await chain('https://a.example.org/0', { maxHops: 3, transport: async () => ({ status: 302, location: `/${++n}` }) });
  assert.equal(endless.outcome, 'max_hops_reached');
  assert.equal(endless.hops.length, 3);
});

test('liveGate is closed by default and needs live + exact approval + isolation', () => {
  const url = 'https://www.example.org/';
  assert.equal(liveGate({ url, env: {} }).allowed, false);
  assert.equal(liveGate({ url, live: true, approve: url, env: {} }).allowed, false);
  assert.equal(liveGate({ url, live: true, approve: 'https://www.example.org/other', env: {}, isolation: ISOLATED }).allowed, false);
  assert.equal(liveGate({ url, live: true, approve: url, env: { HTTPS_PROXY: 'x' }, isolation: ISOLATED }).allowed, false);
  assert.equal(liveGate({ url, live: true, approve: url, env: {}, isolation: ISOLATED }).allowed, true);
});

test('the isolation setting typed by hand is not enough: the real system check decides', () => {
  const url = 'https://www.example.org/';
  const g = liveGate({ url, live: true, approve: url, env: { GITBACK2LIFE_ISOLATED: 'inspect' }, isolation: { isolated: false, reasons: ['not running inside Windows Sandbox'] } });
  assert.equal(g.allowed, false);
  assert.match(g.reasons.join(), /not isolated: not running inside Windows Sandbox/);
  assert.equal(liveGate({ url, live: true, approve: url, env: {} }).allowed, false, 'no isolation result at all means not isolated');
});

test('liveGate refuses a URL that was already checked within the cool-down window', () => {
  const url = 'https://www.example.org/';
  const g = liveGate({ url, live: true, approve: url, env: {}, isolation: ISOLATED, recent: { allowed: false, last: '2026-10-09T00:00:00Z' } });
  assert.equal(g.allowed, false);
  assert.match(g.reasons[0], /once every 24 hours/);
});

test('robots.txt Disallow stops the check before the page is requested', async () => {
  let requests = 0;
  const result = await inspectChain('https://www.example.org/adopt', {
    robots: robotsFrom({ 'https://www.example.org': 'User-agent: *\nDisallow: /adopt' }),
    transport: async () => { requests++; return { status: 200 }; },
  });
  assert.equal(result.outcome, 'blocked_by_robots_txt');
  assert.equal(requests, 0, 'no request was sent');
  assert.match(result.reason, /Disallow: \/adopt/);
});

test('robots.txt is checked again for each new site in a redirect chain', async () => {
  const sent = [];
  const result = await inspectChain('https://www.example.org/', {
    robots: robotsFrom({ 'https://other.example.com': 'User-agent: gitback2life\nDisallow: /' }),
    transport: async (u) => { sent.push(u.href); return u.host === 'www.example.org' ? { status: 301, location: 'https://other.example.com/' } : { status: 200 }; },
  });
  assert.equal(result.outcome, 'blocked_by_robots_txt');
  assert.deepEqual(sent, ['https://www.example.org/'], 'the second site was never contacted');
  assert.equal(result.hops[0].status, 301, 'the redirect that was allowed is still recorded');
});

test('Crawl-delay widens spacing; an excessive Crawl-delay stops the check', async () => {
  let seenDelay;
  await inspectChain('https://www.example.org/', {
    robots: robotsFrom({ 'https://www.example.org': 'User-agent: *\nCrawl-delay: 10' }),
    transport: async (_u, opts) => { seenDelay = opts.crawlDelay; return { status: 200 }; },
  });
  assert.equal(seenDelay, 10, 'the delay is passed to the transport, which spaces requests by it');
  const slow = await inspectChain('https://www.example.org/', {
    robots: robotsFrom({ 'https://www.example.org': 'User-agent: *\nCrawl-delay: 3600' }),
    transport: async () => { throw new Error('should not be called'); },
  });
  assert.equal(slow.outcome, 'blocked_by_robots_txt');
});

test('a redirect to a site outside the incident scope is recorded but never contacted', async () => {
  const sent = [];
  const result = await chain('https://www.example.org/', {
    allowHop: (u) => u.host === 'www.example.org',
    transport: async (u) => { sent.push(u.href); return { status: 302, location: 'https://elsewhere.example.net/' }; },
  });
  assert.equal(result.outcome, 'stopped_out_of_scope');
  assert.deepEqual(sent, ['https://www.example.org/']);
  assert.equal(result.hops[0].location, 'https://elsewhere.example.net/', 'where it pointed is still recorded');
  assert.match(result.hops[1].note, /not contacted/);
});

test('a redirect from https down to http is refused without contacting the http address', async () => {
  const sent = [];
  const result = await chain('https://www.example.org/', {
    transport: async (u) => { sent.push(u.href); return { status: 301, location: 'http://www.example.org/' }; },
  });
  assert.equal(result.outcome, 'blocked_by_guard');
  assert.match(result.hops[0].next_blocked, /https to http refused/);
  assert.deepEqual(sent, ['https://www.example.org/']);
});

test('the default robots checker is the shared fail-closed reader (no private copy)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./redirect_inspector.mjs', import.meta.url), 'utf8');
  assert.match(src, /fetchRobotsPolicy\(url, \{ fetchImpl: guardedFetch \}\)/);
  assert.doesNotMatch(src, /from 'node:(https?|dns)'/, 'no direct network modules: everything goes through _shared/safe_http.mjs');
  assert.doesNotMatch(src, /\bALLOW_ALL\b/, 'no allow-all fallback anywhere in the inspector');
});

test('unreachable robots policy is unknown, not an explicit exclusion', async () => {
  const url='https://example.org/page';
  const got=await inspectChain(url,{robots:async()=>({allowed:false,rule:null,basis:'robots.txt unreachable (EAI_AGAIN)'}),
    transport:async()=>{throw Error('must not request page');}});
  assert.equal(got.outcome,'robots_unverified');
  assert.doesNotMatch(got.reason,/asks automated tools not to/);
});
