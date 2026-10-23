#!/usr/bin/env node
// email_header_triage: look at a saved suspicious email (.eml) OFFLINE and list signs worth checking.
// Never opens links, never runs or extracts attachments, never looks anything up online, never saves the body.
// Shows domains, with email addresses masked unless --show-addresses is given.
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fail, isMain, printJson } from '../_shared/common.mjs';
import { plainText } from '../_shared/output.mjs';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PARTS = 50;
const RISKY_ATTACHMENT = /\.(exe|scr|com|bat|cmd|js|jse|vbs|vbe|wsf|hta|msi|ps1|lnk|iso|img|jar|html?|svg)$/i;

export function splitMessage(raw) {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) } : { head: raw, body: '' };
}

export function parseHeaders(head) {
  const out = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1][1] += ` ${line.trim()}`;
    else {
      const i = line.indexOf(':');
      if (i > 0) out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
    }
  }
  return out;
}

const header = (hs, name) => hs.find(([n]) => n === name)?.[1] ?? null;
const headers = (hs, name) => hs.filter(([n]) => n === name).map(([, v]) => v);

export function address(value) {
  if (!value) return null;
  const angle = /<([^<>@\s]+@[^<>\s]+)>/.exec(value);
  const bare = /([^\s<>"',;:]+@[^\s<>"',;]+)/.exec(value);
  const addr = (angle?.[1] ?? bare?.[1] ?? '').toLowerCase();
  return addr ? { address: addr, domain: addr.split('@')[1].replace(/[>.]+$/, '') } : null;
}

export function displayName(value) {
  if (!value) return '';
  const i = value.indexOf('<');
  return (i > 0 ? value.slice(0, i) : '').replace(/["']/g, '').trim();
}

export const mask = (addr) => addr.replace(/^([^@])[^@]*@/, '$1***@');

export function parseAuthResults(values) {
  const res = {};
  for (const v of values) {
    for (const key of ['spf', 'dkim', 'dmarc']) {
      const m = new RegExp(`\\b${key}=(\\w+)`, 'i').exec(v);
      if (m && !res[key]) res[key] = m[1].toLowerCase();
    }
  }
  return res;
}

function decode(body, encoding) {
  const e = (encoding ?? '').toLowerCase();
  if (e === 'base64') { try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return ''; } }
  if (e === 'quoted-printable') {
    return body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

/** Walk MIME parts: collect text/plain + text/html (decoded) and attachment names/types. Never decodes attachments. */
export function walkParts(hs, body, acc = { texts: [], attachments: [], parts: 0 }, depth = 0) {
  if (depth > 5 || acc.parts >= MAX_PARTS) return acc;
  acc.parts += 1;
  const ctype = header(hs, 'content-type') ?? 'text/plain';
  const disp = header(hs, 'content-disposition') ?? '';
  const name = /(?:file)?name\*?="?([^";]+)"?/i.exec(`${disp}; ${ctype}`)?.[1] ?? null;
  const boundary = /boundary="?([^";]+)"?/i.exec(ctype)?.[1];
  if (/^multipart\//i.test(ctype) && boundary) {
    const chunks = body.split(`--${boundary}`).slice(1);
    for (const chunk of chunks) {
      if (chunk.startsWith('--')) break;
      const { head, body: b } = splitMessage(chunk.replace(/^\r?\n/, ''));
      walkParts(parseHeaders(head), b, acc, depth + 1);
    }
  } else if (/attachment/i.test(disp) || (name && !/^text\/(plain|html)/i.test(ctype))) {
    acc.attachments.push({ name: name ?? '(unnamed)', type: ctype.split(';')[0].trim() });
  } else if (/^text\/(plain|html)/i.test(ctype)) {
    acc.texts.push({ html: /html/i.test(ctype), text: decode(body, header(hs, 'content-transfer-encoding')) });
  }
  return acc;
}

const hostOf = (s) => { try { return new URL(s).hostname.toLowerCase(); } catch { return null; } };
const looksLikeDomain = (s) => /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(s.trim());

export function extractLinks(texts) {
  const links = [];
  for (const t of texts) {
    if (t.html) {
      for (const m of t.text.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const shown = m[2].replace(/<[^>]+>/g, '').trim();
        const shownHost = looksLikeDomain(shown) ? hostOf(/^https?:/i.test(shown) ? shown : `https://${shown}`) : null;
        links.push({ host: hostOf(m[1]), shown_host: shownHost });
      }
    } else {
      for (const m of t.text.matchAll(/https?:\/\/[^\s<>"')]+/gi)) links.push({ host: hostOf(m[0]), shown_host: null });
    }
  }
  return links.filter((l) => l.host);
}

export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

const base = (domain) => domain?.split('.').slice(-2).join('.') ?? null;
const resembles = (domain, expected) => {
  if (!domain || !expected) return false;
  const a = base(domain); const b = base(expected);
  return a !== b && (editDistance(a, b) <= 2 || a.replace(/0/g, 'o').replace(/1/g, 'l') === b);
};

export function triage(raw, { expected = null } = {}) {
  const { head, body } = splitMessage(raw);
  const hs = parseHeaders(head);
  const from = address(header(hs, 'from'));
  const replyTo = address(header(hs, 'reply-to'));
  const returnPath = address(header(hs, 'return-path'));
  const auth = parseAuthResults(headers(hs, 'authentication-results'));
  const { texts, attachments } = walkParts(hs, body);
  const links = extractLinks(texts);
  const signs = [];
  const add = (level, check, message) => signs.push({ level, check, message });

  if (!from) add('review', 'from', 'No readable sender address.');
  if (from && replyTo && base(replyTo.domain) !== base(from.domain)) add('review', 'reply_to', `Replies would go to ${replyTo.domain}, not the sender's domain ${from.domain}.`);
  if (from && returnPath && base(returnPath.domain) !== base(from.domain)) add('info', 'return_path', `Bounce address domain (${returnPath.domain}) differs from the sender's (${from.domain}). Common for mailing services.`);
  const shownAddr = address(displayName(header(hs, 'from')));
  if (from && shownAddr && shownAddr.domain !== from.domain) add('review', 'display_name', `The sender's display name shows an address at ${shownAddr.domain}, but the message actually came from ${from.domain}.`);
  if (!Object.keys(auth).length) add('info', 'authentication', 'No authentication results in the headers (common for forwarded or locally saved copies), so sender checks cannot be read.');
  if (auth.dmarc === 'fail') add('review', 'dmarc', `The message failed the sender domain's DMARC check (${from?.domain ?? 'unknown domain'}).`);
  if (auth.spf && ['fail', 'softfail'].includes(auth.spf)) add(auth.spf === 'fail' ? 'review' : 'info', 'spf', `SPF result: ${auth.spf}.`);
  if (auth.dkim && ['fail', 'none'].includes(auth.dkim)) add('info', 'dkim', `DKIM result: ${auth.dkim}.`);
  if (from?.domain.includes('xn--')) add('review', 'punycode', `The sender's domain uses encoded international characters (${from.domain}), which can imitate familiar names.`);
  if (expected && resembles(from?.domain, expected)) add('review', 'lookalike_sender', `The sender's domain ${from.domain} closely resembles ${expected} but is different.`);
  for (const l of links) {
    if (l.shown_host && base(l.shown_host) !== base(l.host)) add('review', 'link_mismatch', `A link shows ${l.shown_host} but actually goes to ${l.host}.`);
    if (l.host.includes('xn--')) add('review', 'punycode_link', `A link goes to an internationally encoded domain (${l.host}).`);
    if (expected && resembles(l.host, expected)) add('review', 'lookalike_link', `A link goes to ${l.host}, which closely resembles ${expected}.`);
  }
  for (const a of attachments) {
    if (RISKY_ATTACHMENT.test(a.name) || /\.\w{2,4}\.\w{2,4}$/.test(a.name)) add('review', 'attachment', `Attachment "${a.name}" is a type often used to deliver harmful files. Don't open it.`);
  }
  return {
    subject: header(hs, 'subject'), date: header(hs, 'date'),
    from, reply_to: replyTo, return_path: returnPath, authentication: auth,
    link_domains: [...new Set(links.map((l) => l.host))].sort(), attachments, signs,
  };
}

const ICON = { review: '🟡 check', info: '🔵 info ' };
const NOTE = 'These signs do not prove an email is fake, and their absence does not prove it is real. When unsure, contact\n'
  + 'the organization or provider through a phone number or website you already know, never one from the email itself.';

const HELP = `email_header_triage: offline look at a saved suspicious email (.eml). Never opens links or attachments.

  node email_header_triage.mjs <message.eml> [--expected example-rescue.org] [--show-addresses] [--json]

--expected names the domain the email claims to be from, to spot lookalike senders and links.
Email addresses are masked unless --show-addresses is given. The message body is never printed or saved.

${NOTE}`;

export function main(argv) {
  const { values: o, positionals: [file] } = parseArgs({ args: argv, allowPositionals: true, options: {
    expected: { type: 'string' }, 'show-addresses': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (!file || o.help) return console.log(HELP);
  if (statSync(file).size > MAX_BYTES) throw new Error('message is larger than 10 MB');
  const r = triage(readFileSync(file, 'latin1'), { expected: o.expected?.toLowerCase() ?? null });
  const show = (a) => (a ? (o['show-addresses'] ? a.address : mask(a.address)) : '(none)');
  // Output guard (F07): free-text header fields can carry contacts, tokens or secret URLs.
  const view = { ...r, subject: r.subject === null ? null : plainText(r.subject), date: r.date === null ? null : plainText(r.date),
    attachments: r.attachments.map((a) => ({ name: plainText(a.name), type: plainText(a.type) })),
    signs: r.signs.map((s) => ({ ...s, message: plainText(s.message) })),
    from: show(r.from), reply_to: show(r.reply_to), return_path: show(r.return_path) };
  if (o.json) return printJson(view);
  console.log(`Subject: ${view.subject ?? '(none)'}\nDate:    ${view.date ?? '(none)'}\nFrom:    ${view.from}\nReply-To: ${view.reply_to}`);
  console.log(`Sender checks: ${Object.entries(r.authentication).map(([k, v]) => `${k}=${v}`).join(' ') || '(none in headers)'}`);
  console.log(`Link domains: ${r.link_domains.join(', ') || '(none)'}`);
  console.log(`Attachments: ${view.attachments.map((a) => `${a.name} (${a.type})`).join(', ') || '(none)'}\n`);
  if (!r.signs.length) console.log('  No signs from this checklist.');
  for (const s of view.signs) console.log(`  ${ICON[s.level]} ${s.message}`);
  console.log(`\n${NOTE}`);
}

if (isMain(import.meta)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(e.message); }
}
