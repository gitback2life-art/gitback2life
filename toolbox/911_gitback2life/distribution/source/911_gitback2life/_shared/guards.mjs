// Address and URL guards shared by every tool that touches the network. Pure functions; no network.
import { BlockList, isIP } from 'node:net';

export class GuardError extends Error {
  constructor(message) { super(message); this.code = 'GUARD_BLOCKED'; }
}

// Separate lists per family: a BlockList holding IPv6 rules such as ::ffff:0:0/96 also matches
// plain IPv4 addresses, which would wrongly block every public IPv4 address.
const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedV4.addSubnet(net, prefix, 'ipv4');
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blockedV6.addSubnet(net, prefix, 'ipv6');

// IPv6 is allow-listed to global unicast (2000::/3) first, then the blocks above are subtracted.
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');

/** True only for globally routable unicast addresses. Anything unparseable is treated as non-public. */
export function isPublicAddress(address) {
  try {
    const addr = String(address).replace(/^\[|\]$/g, '');
    if (addr.includes('%')) return false; // zone IDs only exist on link-local
    const family = isIP(addr);
    if (family === 4) return !blockedV4.check(addr, 'ipv4');
    if (family === 6) return globalUnicast.check(addr, 'ipv6') && !blockedV6.check(addr, 'ipv6');
    return false;
  } catch {
    return false;
  }
}

const INTERNAL_SUFFIXES = /(^|\.)(localhost|local|internal|lan|home\.arpa|corp|intranet|localdomain)$/;

/** Validate a URL before it is ever contacted. Returns a URL object or throws GuardError. */
export function validateTarget(raw, { allowedPorts = ['', '80', '443'] } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new GuardError('malformed URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new GuardError(`scheme ${u.protocol} is not allowed`);
  if (u.username || u.password) throw new GuardError('URLs with embedded credentials are refused');
  if (!allowedPorts.includes(u.port)) throw new GuardError(`port ${u.port} is not allowed (80/443 only)`);
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new GuardError('missing host');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new GuardError(`non-public IP literal ${host}`);
  } else if (INTERNAL_SUFFIXES.test(host) || !host.includes('.')) {
    throw new GuardError(`internal-looking hostname ${host}`);
  }
  return u;
}

/**
 * Where each outside lookup service may legitimately send requests (including its own redirects).
 * A request that belongs to a service may only go to that service's destinations (F02).
 *   github           API, archive downloads, and Actions log storage (job logs redirect to blob storage)
 *   rdap             the rdap.org bootstrap and registry RDAP servers (rdap.* hosts or /rdap/ paths)
 *   certificate_logs crt.sh   ·   web_archive  web.archive.org   ·   doh  Cloudflare / Google DNS-over-HTTPS
 */
/**
 * V4-01: registry RDAP servers that rdap.org's bootstrap redirects to. EXACT hostnames only: a hostname prefix
 * ("rdap.") or a path ("/rdap/") proves nothing, because anyone can name a host or path that way.
 * This is a reviewed snapshot of common registries (com/net, org, Identity Digital, Google, CentralNic), not the
 * full IANA bootstrap. A registry that is not listed is REFUSED (fail closed). Add one only after checking it
 * against IANA's RDAP bootstrap file (https://data.iana.org/rdap/dns.json), with a test.
 */
export const RDAP_REGISTRY_HOSTS = Object.freeze([
  'rdap.org', 'rdap.verisign.com', 'rdap.publicinterestregistry.org', 'rdap.identitydigital.services',
  'pubapi.registry.google', 'rdap.centralnic.com',
]);
/**
 * GitHub Actions logs are served through short-lived signed links on GitHub-owned hosts or GitHub's results
 * storage accounts. Only those exact patterns: a bare *.blob.core.windows.net suffix would admit ANY Azure tenant.
 */
const GITHUB_LOG_HOST = /^(?:[a-z0-9-]+\.actions\.githubusercontent\.com|productionresultssa\d{1,3}\.blob\.core\.windows\.net)$/;

export const SERVICE_DESTINATIONS = Object.freeze({
  github: (u) => ['api.github.com', 'codeload.github.com'].includes(u.hostname) || GITHUB_LOG_HOST.test(u.hostname),
  rdap: (u) => RDAP_REGISTRY_HOSTS.includes(u.hostname),
  certificate_logs: (u) => u.hostname === 'crt.sh',
  web_archive: (u) => u.hostname === 'web.archive.org',
  doh: (u) => u.hostname === 'cloudflare-dns.com' || u.hostname === 'dns.google',
});

/** Which lookup service a URL belongs to, or null for an ordinary website. */
export function serviceFor(url) {
  const u = url instanceof URL ? url : new URL(String(url));
  return Object.keys(SERVICE_DESTINATIONS).find((s) => SERVICE_DESTINATIONS[s](u)) ?? null;
}

/**
 * Validate one redirect step before following it: the destination must pass validateTarget, and a redirect
 * may never go from https down to plain http. Every redirect in the toolkit goes through this function.
 */
export function checkHop(from, to) {
  const next = validateTarget(String(to?.href ?? to));
  if (from?.protocol === 'https:' && next.protocol === 'http:') {
    throw new GuardError(`redirect from https to http refused (${from.host} → ${next.host})`);
  }
  return next;
}

/**
 * A `lookup` for http.request that resolves once, refuses if ANY address is non-public, and hands the
 * socket exactly the addresses it validated. Validation and connection use the same answer, which
 * closes the DNS-rebinding time-of-check/time-of-use gap.
 */
export function makePinnedLookup(resolveAll) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    Promise.resolve()
      .then(() => resolveAll(hostname))
      .then((addrs) => {
        if (!addrs?.length) throw new GuardError(`${hostname} did not resolve`);
        const bad = addrs.filter((a) => !isPublicAddress(a.address));
        if (bad.length) throw new GuardError(`${hostname} resolves to non-public address(es): ${bad.map((a) => a.address).join(', ')}`);
        if (options?.all) callback(null, addrs.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, addrs[0].address, addrs[0].family);
      })
      .catch((err) => callback(err));
  };
}
