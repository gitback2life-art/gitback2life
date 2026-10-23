// Preload with `node --import <this file> ...` to block ALL outbound network for that process:
// fetch, TCP/TLS sockets (so http/https/undici too), DNS lookups/queries, UDP and WebSocket.
// Local pipes (used by the test runner and child-process stdio) still work.
// Extends the fetch-only offline guard from the gitback2life security suite.
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const blocked = (what) => Object.assign(new Error(`OFFLINE_NETWORK_BLOCKED: ${what}`), { code: 'OFFLINE_NETWORK_BLOCKED' });

globalThis.fetch = async (input) => { throw blocked(`fetch ${String(input?.url ?? input).slice(0, 200)}`); };
if (globalThis.WebSocket) globalThis.WebSocket = class { constructor() { throw blocked('WebSocket'); } };

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // net.connect passes normalized [options, cb]
  const isPipe = typeof first === 'string' ? !/^\d+$/.test(first) : typeof first?.path === 'string';
  if (isPipe) return originalConnect.apply(this, args);
  throw blocked('TCP connect');
};

const isDnsQuery = (name) => name === 'lookup' || name === 'lookupService' || name === 'reverse' || name.startsWith('resolve');
const callbackFail = (name) => function (...args) {
  const cb = args.findLast((a) => typeof a === 'function');
  const err = blocked(`dns.${name}`);
  if (cb) process.nextTick(cb, err); else throw err;
};
const promiseFail = (name) => async () => { throw blocked(`dns.promises.${name}`); };

for (const name of Object.keys(dns)) if (isDnsQuery(name) && typeof dns[name] === 'function') dns[name] = callbackFail(name);
for (const name of Object.getOwnPropertyNames(dns.Resolver.prototype)) if (isDnsQuery(name)) dns.Resolver.prototype[name] = callbackFail(name);
for (const name of Object.keys(dns.promises)) if (isDnsQuery(name) && typeof dns.promises[name] === 'function') dns.promises[name] = promiseFail(name);
for (const name of Object.getOwnPropertyNames(dns.promises.Resolver.prototype)) if (isDnsQuery(name)) dns.promises.Resolver.prototype[name] = promiseFail(name);

dgram.createSocket = () => { throw blocked('UDP socket'); };

syncBuiltinESMExports();
