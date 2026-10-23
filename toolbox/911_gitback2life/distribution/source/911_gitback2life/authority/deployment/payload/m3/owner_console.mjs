// Prepared Windows owner-console prompts for M4. This module DOES NOT start the protected
// authority, request elevation, or activate its currently disabled bootstrap.
import { createInterface } from 'node:readline/promises';

/** Return console callbacks used by the prepared M2/M3 approval path. */
export function createOwnerConsole({ input = process.stdin, output = process.stdout } = {}) {
  const ready = () => {
    if (!input.isTTY || !output.isTTY) throw new Error('owner confirmation requires an interactive terminal');
  };
  const display = (message) => { ready(); output.write(`${message}\n`); };
  const confirm = async () => {
    ready();
    const rl = createInterface({ input, output });
    try { return (await rl.question('Confirmation code: ')).trim(); }
    finally { rl.close(); }
  };
  const readPassphrase = async () => {
    ready();
    if (typeof input.setRawMode !== 'function') throw new Error('hidden passphrase input unavailable');
    output.write('Owner passphrase (hidden): ');
    const previous = Boolean(input.isRaw);
    input.setRawMode(true);
    input.resume();
    let answer = '';
    try {
      return await new Promise((resolve, reject) => {
        const finish = (err) => {
          input.off('data', onData);
          input.off('error', onError);
          if (err) reject(err);
          else resolve(answer);
        };
        const onError = (err) => finish(err);
        const onData = (chunk) => {
          for (const char of String(chunk)) {
            if (char === '\r' || char === '\n') { output.write('\n'); finish(); return; }
            if (char === '\u0003' || char === '\u0004') { output.write('\n'); finish(new Error('owner cancelled passphrase input')); return; }
            if (char === '\b' || char === '\u007f') { answer = answer.slice(0, -1); continue; }
            if (char < ' ' || char === '\u007f') continue;
            if (answer.length >= 1024) { output.write('\n'); finish(new Error('passphrase input exceeds limit')); return; }
            answer += char;
          }
        };
        input.on('data', onData);
        input.on('error', onError);
      });
    } finally { input.setRawMode(previous); }
  };
  return { display, confirm, readPassphrase };
}
