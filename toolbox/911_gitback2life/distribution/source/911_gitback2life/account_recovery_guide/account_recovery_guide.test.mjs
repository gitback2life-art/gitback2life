import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUIDES, renderGeneral, renderProvider } from './account_recovery_guide.mjs';

// Only official provider help sites (and ICANN) may be linked.
const OFFICIAL_HOSTS = new Set(['www.godaddy.com', 'www.namecheap.com', 'support.squarespace.com', 'support.wix.com', 'wordpress.com',
  'support.google.com', 'support.microsoft.com', 'www.facebook.com', 'help.instagram.com', 'lookup.icann.org', 'www.icann.org']);

test('every provider has a name, an official https help site, search terms and notes', () => {
  for (const [key, p] of Object.entries(GUIDES.providers)) {
    assert.ok(p.name && p.notes && p.search_terms?.length, key);
    const u = new URL(p.help_url);
    assert.equal(u.protocol, 'https:', key);
    assert.ok(OFFICIAL_HOSTS.has(u.hostname), `${key}: ${u.hostname} is not on the official-sites list`);
  }
});

test('every URL anywhere in the guides is https and official', () => {
  for (const m of JSON.stringify(GUIDES).matchAll(/https?:\/\/[^\s"),]+/g)) {
    const u = new URL(m[0]);
    assert.equal(u.protocol, 'https:', m[0]);
    assert.ok(OFFICIAL_HOSTS.has(u.hostname), m[0]);
  }
});

test('every rendered guide states who it is for and what helpers never do', () => {
  for (const text of [renderGeneral(), ...Object.keys(GUIDES.providers).map((k) => renderProvider(k))]) {
    assert.match(text, /own authorized people/);
    assert.match(text, /What helpers never do/);
    assert.match(text, /never file recovery requests|File recovery requests/);
  }
});

test('guides never suggest guessing, bypassing, or third-party recovery services', () => {
  const text = JSON.stringify(GUIDES).toLowerCase();
  assert.match(text, /do not guess passwords/);
  for (const bad of ['try common passwords', 'bypass', 'brute', 'social engineer', 'pretend to be']) assert.ok(!text.includes(bad), bad);
});

test('unknown providers give a helpful error', () => {
  assert.throws(() => renderProvider('myspace'), /Known: godaddy/);
});
