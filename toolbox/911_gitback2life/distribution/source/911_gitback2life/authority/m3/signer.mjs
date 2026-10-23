// M3 (design revision 3.4, §§10, 16): the signing-key lifecycle interface. It reads the EXISTING protected key format
// produced by authority_core.generateAuthorityKey (scrypt + AES-256-GCM, Ed25519, PKCS#8) without changing that file.
// The passphrase is obtained from `readPassphrase()` at the moment of signing (production: the elevated console, no
// echo, never from arguments, environment or files), used once, and not stored. Tests use a synthetic passphrase and
// a synthetic key generated in the test; no real key or passphrase is ever involved here.
import { createDecipheriv, createHash, createPrivateKey, createPublicKey, scryptSync, sign, verify } from 'node:crypto';

const fingerprint = (publicKeyPem) => createHash('sha256').update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex');

/** Decrypt the protected key with a passphrase. Throws on a wrong passphrase or an altered key file. */
function unlock(enc, passphrase) {
  if (enc?.kdf !== 'scrypt' || enc.cipher !== 'aes-256-gcm') throw new Error('unsupported key file format');
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('the passphrase must be at least 12 characters');
  const key = scryptSync(passphrase, Buffer.from(enc.salt, 'base64'), enc.keyLen, { N: enc.N, r: enc.r, p: enc.p, maxmem: enc.maxmem });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
  d.setAuthTag(Buffer.from(enc.tag, 'base64'));
  try { return createPrivateKey({ key: Buffer.concat([d.update(Buffer.from(enc.ciphertext, 'base64')), d.final()]), format: 'der', type: 'pkcs8' }); }
  catch { throw new Error('wrong passphrase (or the key file was altered)'); }
}

/**
 * A signer for approve-change: (bytes) → base64 signature. Before returning a signature it checks that the key file's
 * fingerprint matches the PROTECTED public key, and that the signature verifies with it.
 */
export function createPassphraseSigner({ encryptedPrivateKey, publicKeyPem, readPassphrase }) {
  if (encryptedPrivateKey?.fingerprint !== fingerprint(publicKeyPem)) throw new Error('the key file does not belong to the protected public key');
  return (bytes) => {
    const signWithPassphrase = (passphrase) => {
      const privateKey = unlock(encryptedPrivateKey, passphrase);
      const signature = sign(null, bytes, privateKey);
      if (!verify(null, bytes, createPublicKey(publicKeyPem), signature)) throw new Error('signature self-check failed');
      return signature.toString('base64');
    };
    const passphrase = readPassphrase();
    return passphrase && typeof passphrase.then === 'function'
      ? passphrase.then(signWithPassphrase) : signWithPassphrase(passphrase);
  };
}
