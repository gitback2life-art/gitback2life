import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOW_ALL, DISALLOW_ALL, groupFor, isAllowed, parseRobots, policyForStatus } from './robots.mjs';

const SITE = 'https://www.example.org';

test('a site-wide Disallow blocks every page except robots.txt itself', () => {
  const p = parseRobots('User-agent: *\nDisallow: /');
  assert.equal(isAllowed(p, `${SITE}/`).allowed, false);
  assert.equal(isAllowed(p, `${SITE}/adopt`).allowed, false);
  assert.equal(isAllowed(p, `${SITE}/robots.txt`).allowed, true);
});

test('longest match wins and Allow wins ties', () => {
  const p = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/adopt\nDisallow: /x\nAllow: /x');
  assert.equal(isAllowed(p, `${SITE}/private/notes`).allowed, false);
  assert.equal(isAllowed(p, `${SITE}/private/adopt/form`).allowed, true);
  assert.equal(isAllowed(p, `${SITE}/x`).allowed, true, 'tie goes to Allow');
});

test('wildcards and end anchors', () => {
  const p = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*?q=');
  assert.equal(isAllowed(p, `${SITE}/files/report.pdf`).allowed, false);
  assert.equal(isAllowed(p, `${SITE}/files/report.pdf?download=1`).allowed, true, '$ anchors the end');
  assert.equal(isAllowed(p, `${SITE}/search/all?q=cats`).allowed, false, 'query strings are matched too');
});

test('a group naming gitback2life replaces the * group; groups for us are merged', () => {
  const p = parseRobots([
    'User-agent: *', 'Disallow: /',
    '', 'User-agent: GitBack2Life', 'Disallow: /donors',
    '', 'User-agent: gitback2life', 'Crawl-delay: 5', 'Disallow: /admin',
  ].join('\n'));
  assert.equal(isAllowed(p, `${SITE}/`).allowed, true, 'our own group allows / even though * does not');
  assert.equal(isAllowed(p, `${SITE}/donors/list`).allowed, false);
  assert.equal(isAllowed(p, `${SITE}/admin`).allowed, false);
  assert.equal(groupFor(p).crawlDelay, 5);
});

test('consecutive user-agent lines share one group; comments and junk are ignored', () => {
  const p = parseRobots('# hello\nUser-agent: googlebot\nUser-agent: gitback2life # us\nDisallow: /a\nnonsense line\nSitemap: https://x/s.xml');
  assert.equal(isAllowed(p, `${SITE}/a`).allowed, false);
  assert.equal(isAllowed(p, `${SITE}/b`).allowed, true);
});

test('empty Disallow allows everything; percent-escapes compare case-insensitively', () => {
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), `${SITE}/anything`).allowed, true);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /caf%c3%a9'), `${SITE}/caf%C3%A9`).allowed, false);
});

test('HTTP status rules from RFC 9309: 4xx allows, 5xx and unreachable disallow', () => {
  assert.equal(policyForStatus(404).policy, ALLOW_ALL);
  assert.equal(policyForStatus(403).policy, ALLOW_ALL);
  assert.equal(policyForStatus(503).policy, DISALLOW_ALL);
  assert.equal(isAllowed(policyForStatus(200, 'User-agent: *\nDisallow: /').policy, `${SITE}/`).allowed, false);
});
