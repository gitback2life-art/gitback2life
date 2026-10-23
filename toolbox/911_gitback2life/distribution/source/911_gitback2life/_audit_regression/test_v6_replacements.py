# Replacement for the v6 review's V6-01 Python check (test_v6_independent.py keeps the original, unchanged).
# Why a replacement: v7 no longer reads signed authorizations from a sidecar beside the scope, so the original passes
# for a weaker reason (no authorization is found at all). This version stores the signature where v7 looks for it
# (the protected folder's authorizations/<incident>.json), so the ONLY thing standing between the attacker and a
# write is the same-bytes guarantee: Python verifies exactly the bytes it parsed, sent to the verifier over stdin.
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import unittest, tempfile, json, subprocess, shutil
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '_shared'))
import gb2l_core as core

SIGNED_SCOPE = {'incident_id': 'synthetic-swap', 'status': 'open', 'expires_at': '2099-01-01T00:00:00Z', 'persistence': 'local',
                'permissions': {'save_local': False}, 'question': 'q', 'scope': 's', 'stopping_condition': 'c',
                'targets': ['alpha.example'], 'urgency': 'normal', 'confidence': 'low', 'prohibited': ['p'],
                'disclosures': [], 'approvals': []}


class V601Replacement(unittest.TestCase):
    def setUp(self):
        parent = ROOT / '.test_tmp'; parent.mkdir(exist_ok=True)
        self.d = Path(tempfile.mkdtemp(prefix='replacement-v6-', dir=parent))
        core.clear_active_scope()
        self.node = shutil.which('node')
        self.auth = self.d / 'auth'; self.auth.mkdir()
        for f in ('authority_core.mjs', 'authority_cli.mjs'):
            shutil.copyfile(ROOT / 'authority' / f, self.auth / f)
        js = ('import {generateAuthorityKey,signAuthorization,recordApproval,emptyState} from ' + json.dumps((self.auth / 'authority_core.mjs').as_uri())
              + ';const s=' + json.dumps(SIGNED_SCOPE) + ';const pass="synthetic testing passphrase";const k=generateAuthorityKey(pass);'
              'console.log(JSON.stringify({pub:k.publicKeyPem,signed:signAuthorization(s,{...k,passphrase:pass,serial:1}),state:recordApproval(emptyState(),s.incident_id,1)}));')
        g = json.loads(subprocess.run([self.node, '--input-type=module', '-e', js], capture_output=True, text=True, check=True).stdout)
        (self.auth / 'public_key.pem').write_text(g['pub'])
        (self.auth / 'state.json').write_text(json.dumps(g['state']))
        (self.auth / 'authorizations').mkdir()
        (self.auth / 'authorizations' / 'synthetic-swap.json').write_text(json.dumps(g['signed']))  # where v7 looks
        self.p = self.d / 'scope.json'
        core._set_authority_for_tests(self.auth, check_acl=False, node=self.node)

    def tearDown(self):
        core.clear_active_scope(); core._reset_authority(); shutil.rmtree(self.d, ignore_errors=True)
        try: (ROOT / '.test_tmp').rmdir()
        except OSError: pass

    def test_control_the_signed_scope_verifies(self):
        # Without this, the attack test below could pass merely because the fixture never verifies. (The signed scope
        # itself does not permit save_local, as in the review's fixture, so the verifier is called directly.)
        core._check_authority(json.dumps(SIGNED_SCOPE).encode('utf-8'))
        with self.assertRaises(core.InputError):
            core._check_authority(json.dumps({**SIGNED_SCOPE, 'permissions': {'save_local': True}}).encode('utf-8'))

    def test_swapping_in_the_signed_scope_at_verify_time_does_not_authorize_the_unsigned_one(self):
        self.p.write_text(json.dumps({**SIGNED_SCOPE, 'permissions': {'save_local': True}}))  # unsigned, broader
        original = subprocess.run
        seen = []
        def interleave(args, **kwargs):
            if len(args) > 2 and args[2] == 'verify':
                self.p.write_text(json.dumps(SIGNED_SCOPE))  # attacker swaps the signed scope in at verify time
                seen.append((args[3], kwargs.get('input')))
            return original(args, **kwargs)
        with patch.object(subprocess, 'run', side_effect=interleave):
            with self.assertRaises(core.InputError):
                core.require_scope(self.p)
        self.assertEqual(len(seen), 1, 'the verifier ran once')
        self.assertEqual(seen[0][0], '-', 'the verifier read the scope from stdin, not from the path')
        self.assertIn(b'"save_local": true', seen[0][1], 'it was given the bytes Python parsed (the unsigned scope)')
        self.assertFalse(list(self.d.glob('out*')), 'no output')

    def test_the_same_swap_at_the_persistence_recheck_blocks_the_write_and_creates_no_output(self):
        # The review asks for the interleaving at each persistence recheck too. Here the SIGNED scope permits saving;
        # the attacker's unsigned copy differs only in its targets.
        saving = {**SIGNED_SCOPE, 'incident_id': 'synthetic-save', 'permissions': {'save_local': True}}
        js = ('import {generateAuthorityKey,signAuthorization,recordApproval,emptyState} from ' + json.dumps((self.auth / 'authority_core.mjs').as_uri())
              + ';const s=' + json.dumps(saving) + ';const pass="synthetic testing passphrase";const k=generateAuthorityKey(pass);'
              'console.log(JSON.stringify({pub:k.publicKeyPem,signed:signAuthorization(s,{...k,passphrase:pass,serial:1}),state:recordApproval(emptyState(),s.incident_id,1)}));')
        g = json.loads(subprocess.run([self.node, '--input-type=module', '-e', js], capture_output=True, text=True, check=True).stdout)
        (self.auth / 'public_key.pem').write_text(g['pub'])
        (self.auth / 'state.json').write_text(json.dumps(g['state']))
        (self.auth / 'authorizations' / 'synthetic-save.json').write_text(json.dumps(g['signed']))
        self.p.write_text(json.dumps(saving))
        core.require_scope(self.p)  # control: the signed scope is accepted and becomes the active scope
        core.write_bytes_safely(self.d / 'control' / 'ok.txt', b'synthetic')  # control: an untampered scope can write
        self.assertTrue((self.d / 'control' / 'ok.txt').exists())
        self.p.write_text(json.dumps({**saving, 'targets': ['alpha.example', 'beta.example']}))  # unsigned, broader
        original = subprocess.run
        def interleave(args, **kwargs):
            if len(args) > 2 and args[2] == 'verify':
                self.p.write_text(json.dumps(saving))  # swapped back to the signed scope at verify time
            return original(args, **kwargs)
        target = self.d / 'out' / 'saved.txt'
        with patch.object(subprocess, 'run', side_effect=interleave):
            with self.assertRaises(core.InputError) as cm:
                core.write_bytes_safely(target, b'synthetic')
        self.assertIn('protected authority', str(cm.exception), 'refused by the signature check on the bytes Python read')
        self.assertFalse(target.exists(), 'no output')
        self.assertFalse((self.d / 'out').exists() and any((self.d / 'out').iterdir()), 'nothing at all written')


if __name__ == '__main__':
    unittest.main(verbosity=2)
