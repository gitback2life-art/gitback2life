// robots.txt support following RFC 9309 (the Robots Exclusion Protocol). Pure parsing and matching, no network;
// the tool that fetches pages also fetches robots.txt, through its own guarded transport and polite limits.
//
// Sites can address this toolkit by name with "User-agent: gitback2life".

export const ROBOTS_TOKEN = 'gitback2life';
export const userAgent = (tool) => `${ROBOTS_TOKEN}/1.0 (${tool}; respects robots.txt)`;
export const MAX_ROBOTS_BYTES = 500 * 1024; // RFC 9309: parse at least 500 KiB; we parse at most that
export const MAX_CRAWL_DELAY_SECONDS = 60;  // a longer Crawl-delay means "please don't": we stop instead

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? '').slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(raw.replace(/#.*$/, '').trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [], crawlDelay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue; // rules before any user-agent line belong to no group
    if ((key === 'allow' || key === 'disallow') && value) current.rules.push({ allow: key === 'allow', pattern: value });
    else if (key === 'crawl-delay' && Number.isFinite(Number(value)) && Number(value) >= 0) current.crawlDelay = Number(value);
  }
  return { groups };
}

export const ALLOW_ALL = Object.freeze({ groups: [] });
export const DISALLOW_ALL = Object.freeze(parseRobots('User-agent: *\nDisallow: /'));

/** Our group: every group naming our token, otherwise every "*" group, merged (RFC 9309 §2.2.1). */
export function groupFor(policy, token = ROBOTS_TOKEN) {
  const t = token.toLowerCase();
  const pick = (want) => policy.groups.filter((g) => g.agents.includes(want));
  const groups = pick(t).length ? pick(t) : pick('*');
  const delays = groups.map((g) => g.crawlDelay).filter((d) => d !== null);
  return { rules: groups.flatMap((g) => g.rules), crawlDelay: delays.length ? Math.max(...delays) : null };
}

const upperEscapes = (s) => s.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());

function toRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => upperEscapes(part).replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Longest matching rule wins; on a tie, Allow wins; no match means allowed (RFC 9309 §2.2.2). */
export function isAllowed(policy, url, token = ROBOTS_TOKEN) {
  const u = new URL(url);
  if (u.pathname === '/robots.txt') return { allowed: true, rule: null };
  const path = upperEscapes(u.pathname + u.search);
  let best = null;
  for (const r of groupFor(policy, token).rules) {
    if (!toRegex(r.pattern).test(path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
  }
  return { allowed: !best || best.allow, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` : null };
}

/**
 * What a robots.txt response means (RFC 9309 §2.3.1):
 *   2xx → parse it · 4xx ("unavailable") → no restrictions · 5xx or unreachable → assume everything is disallowed.
 */
export function policyForStatus(status, body) {
  if (status >= 200 && status < 300) return { policy: parseRobots(body), basis: `robots.txt (HTTP ${status})` };
  if (status >= 400 && status < 500) return { policy: ALLOW_ALL, basis: `no robots.txt (HTTP ${status})` };
  return { policy: DISALLOW_ALL, basis: `robots.txt unreachable (HTTP ${status}); treating the site as off-limits` };
}
