// Offline, metadata-only inventory for preparing the owner's migration decision.
// Never migrates, repairs, creates, deletes, or opens private keys/authorization values.
// This is NOT a Windows ACL, ownership, elevation or G0b/G2 security attestation.
import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PATHS = Object.freeze({
  legacyCode: 'authority_cli.mjs', legacyState: 'state.json', legacyKey: 'private_key.enc.json',
  legacyPublic: 'public_key.pem', legacyAuthorizations: 'authorizations',
  receipt: 'installed_manifest.json', newBootstrap: 'bootstrap.mjs', newLauncher: 'authority.cmd',
  ledger: 'ledger/ledger.log', lock: 'ledger/authority.lock',
  staging: 'staging', journal: 'journal', evidence: 'evidence',
  registers: 'data/registers', restores: 'data/restores',
});
const err = (message) => { throw new Error(`offline assessment refused: ${message}`); };

// Stat every part without following symlinks; directory junctions are reported as unsafe, not traversed.
function item(root, rel) {
  let cur = root;
  const parts = rel.split('/');
  for (const [index, part] of parts.entries()) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch (e) {
      if (e.code === 'ENOENT') return 'absent';
      throw e;
    }
    if (st.isSymbolicLink()) return 'unsafe_link';
    if (index < parts.length - 1 && !st.isDirectory()) return 'unexpected_type';
  }
  const st = lstatSync(cur);
  return st.isDirectory() ? 'directory' : st.isFile() && st.nlink === 1 ? 'file' : 'unexpected_type';
}

/** Inspect an explicitly supplied test/owner-selected folder WITHOUT writing or reading confidential contents. */
export function assessOfflineLayout(folder) {
  if (typeof folder !== 'string' || !folder.trim()) err('an explicit folder path is required');
  const root = resolve(folder);
  let rootStat;
  try { rootStat = lstatSync(root); } catch (e) {
    if (e.code === 'ENOENT') return { classification: 'absent', migration: 'not_applicable', locations: {}, rootExists: false };
    throw e;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) err('the selected root is not an ordinary directory');
  const locations = Object.fromEntries(Object.entries(PATHS).map(([k, rel]) => [k, item(root, rel)]));
  // Never follow unknown folders or inspect documents. Only count immediate root entries.
  const rootEntryCount = readdirSync(root).length;
  const unsafe = Object.values(locations).some((v) => v === 'unsafe_link' || v === 'unexpected_type');
  const legacy = ['legacyCode','legacyState','legacyKey','legacyPublic','legacyAuthorizations'].some((k) => locations[k] !== 'absent');
  const modern = ['receipt','newBootstrap','newLauncher','ledger','lock','staging','journal','evidence','registers','restores'].some((k) => locations[k] !== 'absent');
  const completeLegacy = ['legacyCode','legacyState','legacyKey','legacyPublic'].every((k) => locations[k] === 'file')
    && locations.legacyAuthorizations === 'directory';
  const predeploy = locations.receipt === 'file' && locations.newBootstrap === 'file'
    && locations.newLauncher === 'file' && locations.ledger === 'absent'
    && locations.legacyState === 'absent' && locations.legacyKey === 'absent' && !unsafe;
  let classification = 'unknown_existing_preserve';
  if (unsafe) classification = 'unsafe_existing_preserve';
  else if (legacy && modern) classification = 'mixed_existing_preserve';
  else if (completeLegacy) classification = 'legacy_v7_shape_requires_owner_review';
  else if (predeploy) classification = 'predeployment_shape_inactive_unverified';
  // Predeployment is a shape only; the installation receipt is deliberately NOT trusted as validation.
  return { classification, migration: legacy || (modern && !predeploy) ? 'owner_review_required' : 'not_implemented',
    locations, rootEntryCount, rootExists: true, limitation: 'Shape only; no file contents, ACLs, identities, trust or history verified. No migration or installation performed.' };
}
