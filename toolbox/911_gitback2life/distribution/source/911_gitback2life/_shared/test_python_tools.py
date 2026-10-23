"""Offline tests for the Python tools. Run from the toolbox root:  python -I -m unittest _shared/test_python_tools.py -v
Temporary files live in a throwaway folder inside the toolbox and are removed after each test."""
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import unittest
import uuid
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True  # no __pycache__ files in the toolkit
sys.path.insert(0, str(ROOT / '_shared'))
import gb2l_core as core  # noqa: E402


def load_tool(folder, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / folder / f'{name}.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


code_flow_scan = load_tool('code_flow_scan', 'code_flow_scan')
dependency_inventory = load_tool('dependency_inventory', 'dependency_inventory')
safe_backup = load_tool('safe_backup', 'safe_backup')
org_registers = load_tool('org_registers', 'org_registers')
incident_timeline = load_tool('incident_timeline', 'incident_timeline')
metadata_scrub = load_tool('metadata_scrub', 'metadata_scrub')
access_offboarding = load_tool('access_offboarding', 'access_offboarding')


class Workspace(unittest.TestCase):
    def setUp(self):
        self.tmp = ROOT / '.test_tmp' / uuid.uuid4().hex
        self.tmp.mkdir(parents=True)

    def tearDown(self):
        core.clear_active_scope()  # a scope stays active for the rest of a command; each test is its own command
        shutil.rmtree(self.tmp, ignore_errors=True)
        try:
            (ROOT / '.test_tmp').rmdir()
        except OSError:
            pass

    def put(self, rel, content):
        p = self.tmp / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content if isinstance(content, bytes) else content.encode('utf-8'))
        return p


class CoreTests(Workspace):
    def test_relative_rejects_traversal_and_sensitive_names(self):
        for bad in ['../x.js', '/abs.js', 'a/../b.js', 'C:/x.js', '.env', 'config/.env.local', 'donors/list.csv',
                    'keys/private_key.txt', 'db.sqlite', 'con.txt']:
            with self.assertRaises(core.InputError, msg=bad):
                core.relative(bad)
        self.assertEqual(core.relative('src/app.js'), 'src/app.js')

    def test_labels_refuse_emails_and_phone_numbers_but_keep_dates_and_ids(self):
        for bad in ['jane@example.org', 'contact: volunteer.lead@rescue-nyc.org', '212-555-0100', '(212) 555-0100', '+1 212.555.0100']:
            with self.assertRaises(core.InputError, msg=bad):
                core.label(bad)
        for ok in ['board_secretary', '2026-10-08', '2026-10-08T00:00:00Z', 'run-36438667140-65-of-311-flagged',
                   '@scope/package', 'Example Registrar', 'MIT']:
            self.assertEqual(core.label(ok), ok)

    def test_registers_reject_contact_details(self):
        reg = {'schema_version': 1, 'history': [],
               'records': [dict(org_registers.TEMPLATES['service'], account_owner_role='jane@example.org')]}
        with self.assertRaises(core.InputError):
            org_registers.validate_register('service', reg)

    def test_writes_are_limited_to_the_toolbox(self):
        with self.assertRaises(core.InputError):
            core.inside_toolbox(ROOT.parent / 'outside.json')

    def test_report_result_precedence(self):
        r = core.report('t', [core.check('a', 'pass', 'x'), core.check('b', 'unresolved', 'x')])
        self.assertEqual(r['result'], 'unresolved')
        r = core.report('t', [core.check('a', 'fail', 'x'), core.check('b', 'unresolved', 'x')])
        self.assertEqual(r['result'], 'fail')
        self.assertEqual(core.report('t', [])['result'], 'unresolved')


class CodeFlowScanTests(Workspace):
    def test_scan_flags_storage_outbound_and_third_party_scripts(self):
        self.put('site/app.js', "localStorage.setItem('k', v);\nfetch('https://x.example/api');\n")
        self.put('site/index.html', '<script src="https://cdn.example/t.js"></script>\n')
        r = code_flow_scan.scan({'root': str(self.tmp / 'site'), 'files': ['app.js', 'index.html'], 'source_version': 'test'})
        rules = {(f['file'], f['rule']) for f in r['findings']}
        self.assertIn(('app.js', 'storage'), rules)
        self.assertIn(('app.js', 'outbound'), rules)
        self.assertIn(('index.html', 'third_party_script'), rules)
        self.assertEqual(r['result'], 'unresolved')  # a static scan is never proof
        self.assertNotIn('localStorage', json.dumps(r))  # no source snippets in reports

    def test_disclosure_flags_absolute_claims(self):
        self.put('site/privacy.md', 'Your data is 100% secure and we never store anything.\n')
        r = code_flow_scan.scan({'root': str(self.tmp / 'site'), 'files': ['privacy.md'], 'source_version': 'test'}, disclosure=True)
        self.assertEqual({f['rule'] for f in r['findings']}, {'absolute_privacy', 'absolute_security'})

    def test_discover_skips_node_modules_and_sensitive_files(self):
        self.put('site/a.js', 'x')
        self.put('site/node_modules/lib/b.js', 'x')
        self.put('site/.env', 'SECRET=1')
        self.put('site/donors/list.json', '[]')
        self.assertEqual(code_flow_scan.discover(self.tmp / 'site')['files'], ['a.js'])


class DependencyInventoryTests(Workspace):
    def test_inventory_and_exact_version_advisory_match(self):
        self.put('p/package.json', json.dumps({'dependencies': {'left-pad': '^1.3.0'}}))
        self.put('p/package-lock.json', json.dumps({'lockfileVersion': 3, 'packages': {
            '': {}, 'node_modules/left-pad': {'version': '1.3.0', 'license': 'WTFPL'},
            'node_modules/mystery': {'version': '0.0.1'}}}))
        r = dependency_inventory.dependencies({'root': str(self.tmp / 'p'), 'manifest': 'package.json', 'lockfile': 'package-lock.json',
                                               'source_version': 'test', 'advisories': {'observed_at': '2026-10-08T00:00:00Z', 'source': 'osv.dev',
                                                                                       'affected': [{'name': 'left-pad', 'version': '1.3.0', 'advisory_id': 'TEST-1'}]}})
        self.assertEqual(r['result'], 'fail')
        self.assertEqual(r['advisories'][0]['advisory_id'], 'TEST-1')
        self.assertIn({'unknown_license': 'mystery'}, r['findings'])


class SafeBackupTests(Workspace):
    def selection(self):
        self.put('site/index.html', '<h1>Adopt</h1>')
        self.put('site/data/orgs.json', '[]')
        return {'root': str(self.tmp / 'site'), 'files': ['index.html', 'data/orgs.json'], 'exclude': [], 'source_version': 'test'}

    def test_backup_and_restore_round_trip(self):
        sel = self.selection()
        manifest = safe_backup.preview(sel)
        r = safe_backup.backup(sel, self.tmp / 'backup1', manifest)
        self.assertEqual(r['result'], 'pass')
        r = safe_backup.restore(self.tmp / 'backup1', self.tmp / 'restored')
        self.assertEqual(r['result'], 'pass')
        self.assertEqual((self.tmp / 'restored' / 'index.html').read_text(), '<h1>Adopt</h1>')

    def test_backup_refuses_if_source_changed_since_preview(self):
        sel = self.selection()
        manifest = safe_backup.preview(sel)
        self.put('site/index.html', '<h1>changed</h1>')
        with self.assertRaises(core.InputError):
            safe_backup.backup(sel, self.tmp / 'backup2', manifest)

    def test_restore_refuses_tampered_backup_and_existing_destination(self):
        sel = self.selection()
        safe_backup.backup(sel, self.tmp / 'b', safe_backup.preview(sel))
        with self.assertRaises(core.InputError):
            safe_backup.restore(self.tmp / 'b', self.tmp / 'site')  # exists
        (self.tmp / 'b' / 'files' / 'index.html').write_text('tampered')
        with self.assertRaises(core.InputError):
            safe_backup.restore(self.tmp / 'b', self.tmp / 'r2')

    def test_backup_outside_toolbox_is_refused(self):
        sel = self.selection()
        with self.assertRaises(core.InputError):
            safe_backup.backup(sel, ROOT.parent / 'gb2l-escape', safe_backup.preview(sel))


class MaskedStorageTests(Workspace):
    """#10 (owner's decision, option b): synthetic secrets never reach any Python storage path."""
    SECRETS = {'github': 'ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01', 'aws': 'AKIASYNTHETIC0000001',
               'url_password': 'SYNTHETICurlPassw0rd', 'url_token': 'SYNTHETICquerytoken42',
               'email': 'synthetic.person@example-rescue.org', 'phone': '212-555-0100',
               'key': 'SYNTHETICKEYMATERIAL'}
    CARRIER = ('token %(github)s aws %(aws)s\nhttps://admin:%(url_password)s@alpha.org/x\nhttps://alpha.org/cb?token=%(url_token)s\n'
               'contact %(email)s or %(phone)s\n-----BEGIN PRIVATE KEY-----\n%(key)s\n-----END PRIVATE KEY-----\n')

    def carrier(self):
        return self.CARRIER % self.SECRETS

    def assert_clean(self, folder):
        files = [p for p in folder.rglob('*') if p.is_file()]
        self.assertTrue(files, 'something was written')
        for p in files:
            data = p.read_bytes().decode('latin-1')
            for kind, value in self.SECRETS.items():
                self.assertNotIn(value, data, f'{kind} reached {p.name}')

    def test_text_writes_new_and_overwrite_and_json_reports_are_masked(self):
        out = self.tmp / 'out'; out.mkdir()
        core.write_bytes_safely(out / 'a.txt', self.carrier().encode())
        core.write_bytes_safely(out / 'a.txt', (self.carrier() + 'v2').encode(), overwrite=True)  # temp-file path
        core.write(out / 'report.json', {'note': self.carrier()})
        core.emit({'result': 'pass', 'detail': self.carrier()}, out / 'emitted.json', self.scope())
        self.assert_clean(out)
        self.assertEqual(sorted(p.name for p in out.iterdir()), ['a.txt', 'emitted.json', 'report.json'], 'no temp file left')

    def test_url_credentials_are_removed_whole_not_half_matched_as_an_email(self):
        masked = core.mask_for_storage('https://admin:pw@alpha.org/x')
        self.assertEqual(masked, 'https://[REDACTED]@alpha.org/x')

    def test_binary_is_refused_unless_a_metadata_free_image(self):
        out = self.tmp / 'bin'; out.mkdir()
        for data, kind in ((b'PK\x03\x04' + zlib.compress(self.carrier().encode()), None), (bytes([0, 1, 2, 255]), None),
                           (png_with_text(), 'image'), (jpeg_with_exif(), 'image'), (b'%PDF-1.7\x00\x01', 'image')):
            with self.assertRaises(core.InputError, msg=repr(data[:8])):
                core.write_bytes_safely(out / 'x.bin', data, binary=kind)
        self.assertEqual(list(out.iterdir()), [], 'nothing reached disk')
        result = metadata_scrub.scrub_png(png_with_text())
        cleaned = result[0] if isinstance(result, tuple) else result
        core.write_bytes_safely(out / 'clean.png', cleaned, binary='image')  # a scrubbed image IS accepted
        self.assertEqual(core.image_metadata((out / 'clean.png').read_bytes()), [])

    def test_backups_keep_only_files_that_masking_would_not_change(self):
        self.put('site/index.html', '<h1>Adopt</h1>')
        self.put('site/config.js', self.carrier())
        sel = {'root': str(self.tmp / 'site'), 'files': ['index.html', 'config.js'], 'exclude': [], 'source_version': 'test'}
        with self.assertRaises(core.InputError):
            safe_backup.backup(sel, self.tmp / 'backup-secret', safe_backup.preview(sel))
        if (self.tmp / 'backup-secret').exists():
            self.assert_clean(self.tmp / 'backup-secret')
        clean = {**sel, 'files': ['index.html']}
        self.assertEqual(safe_backup.backup(clean, self.tmp / 'backup-ok', safe_backup.preview(clean))['result'], 'pass')
        (self.tmp / 'site' / 'archive.zip').write_bytes(b'PK\x03\x04\x00\x00\xff')  # opaque binary
        zsel = {**sel, 'files': ['archive.zip']}
        with self.assertRaises(core.InputError):
            safe_backup.backup(zsel, self.tmp / 'backup-zip', safe_backup.preview(zsel))

    def scope(self):
        s = {'incident_id': 'test', 'status': 'open', 'expires_at': '2099-01-01T00:00:00Z', 'persistence': 'local',
             'permissions': {'save_local': True}, 'question': 'q', 'scope': 's', 'stopping_condition': 'c',
             'targets': ['example.org'], 'urgency': 'normal', 'confidence': 'low', 'prohibited': ['p'],
             'disclosures': [], 'approvals': []}
        return self.put(f'scope-{uuid.uuid4().hex}.json', json.dumps(s))


class AuthorityTests(Workspace):
    """Pre-install review finding 3: Python writers enforce the protected authority exactly like Node."""
    PASS = 'synthetic python test passphrase'

    def setUp(self):
        super().setUp()
        import shutil as sh
        self.node = sh.which('node')
        self.auth = self.tmp / 'authority'; self.auth.mkdir()
        for f in ('authority_core.mjs', 'authority_cli.mjs'):
            sh.copyfile(ROOT / 'authority' / f, self.auth / f)
        self.scope_data = {'incident_id': 'incident-py', 'status': 'open', 'expires_at': '2099-01-01T00:00:00Z', 'persistence': 'local',
                           'permissions': {'save_local': True}, 'question': 'q', 'scope': 's', 'stopping_condition': 'c',
                           'targets': ['example.org'], 'urgency': 'normal', 'confidence': 'low', 'prohibited': ['p'],
                           'disclosures': [], 'approvals': []}
        self.scope_path = self.put('scope.json', json.dumps(self.scope_data))
        core_url = (ROOT / 'authority' / 'authority_core.mjs').as_uri()
        js = (f"import {{ generateAuthorityKey, signAuthorization, recordApproval, emptyState }} from '{core_url}';"
              "let d=''; process.stdin.on('data', c => d += c).on('end', () => { const { scope, pass } = JSON.parse(d);"
              " const k = generateAuthorityKey(pass); const signed = signAuthorization(scope, { ...k, passphrase: pass, serial: 1 });"
              " console.log(JSON.stringify({ pub: k.publicKeyPem, signed, state: recordApproval(emptyState(), scope.incident_id, 1) })); });")
        out = json.loads(subprocess.run([self.node, '--input-type=module', '-e', js], input=json.dumps({'scope': self.scope_data, 'pass': self.PASS}),
                                        capture_output=True, text=True, check=True).stdout)
        (self.auth / 'public_key.pem').write_text(out['pub'])
        self.state = out['state']
        (self.auth / 'state.json').write_text(json.dumps(self.state))
        self.signed = out['signed']
        core._set_authority_for_tests(self.auth, check_acl=False, node=self.node)

    def tearDown(self):
        core._reset_authority()
        super().tearDown()

    def sign(self):
        # v7: signed authorizations live INSIDE the protected folder (authorizations/<incident>.json); no sidecar.
        (self.auth / 'authorizations').mkdir(exist_ok=True)
        (self.auth / 'authorizations' / 'incident-py.json').write_text(json.dumps(self.signed))

    def test_a_sidecar_beside_the_scope_is_ignored(self):
        Path(str(self.scope_path) + '.authorization.json').write_text(json.dumps(self.signed))
        with self.assertRaises(core.InputError) as cm:
            core.require_scope(self.scope_path)
        self.assertIn('no signed authorization', str(cm.exception))

    def test_unsigned_scope_is_refused(self):
        with self.assertRaises(core.InputError) as cm:
            core.require_scope(self.scope_path)
        self.assertIn('protected authority', str(cm.exception))

    def test_signed_scope_is_accepted_and_a_protected_stop_blocks_the_next_write(self):
        self.sign()
        core.require_scope(self.scope_path)
        core.write_bytes_safely(self.tmp / 'first.txt', b'1')
        state = dict(self.state); state['incidents'] = {'incident-py': {**self.state['incidents']['incident-py'], 'revoked': True, 'revoked_at': 'now'}}
        (self.auth / 'state.json').write_text(json.dumps(state))
        with self.assertRaises(core.InputError) as cm:
            core.write_bytes_safely(self.tmp / 'second.txt', b'2')
        self.assertIn('STOPPED', str(cm.exception))
        self.assertFalse((self.tmp / 'second.txt').exists())

    def test_editing_the_scope_after_signing_is_refused(self):
        self.sign()
        self.scope_path.write_text(json.dumps({**self.scope_data, 'targets': ['example.org', 'other.org']}))
        with self.assertRaises(core.InputError) as cm:
            core.require_scope(self.scope_path)
        self.assertIn('no longer says what was signed', str(cm.exception))

    def test_a_planted_unprotected_folder_is_refused_before_anything_in_it_runs(self):
        self.sign()
        (self.auth / 'authority_cli.mjs').write_text("process.exit(0) // would say VALID if it ever ran")
        core._set_authority_for_tests(self.auth, check_acl=True, node=self.node)
        with self.assertRaises(core.InputError) as cm:
            core.require_scope(self.scope_path)
        self.assertIn('not trustworthy', str(cm.exception))

    def test_python_and_node_apply_identical_protection_rules(self):
        ok = {'exists': True, 'reparse': False, 'owner': 'BUILTIN\\Administrators', 'aces': [
            {'identity': 'BUILTIN\\Administrators', 'rights': 'FullControl', 'type': 'Allow'},
            {'identity': 'BUILTIN\\Users', 'rights': 'ReadAndExecute, Synchronize', 'type': 'Allow'}]}
        cases = [ok, {**ok, 'owner': 'PC\\someone'}, {'exists': True, 'reparse': False, 'owner': 'BUILTIN\\Administrators'},
                 {**ok, 'aces': []}, {**ok, 'aces': ok['aces'] + [{'identity': 'Everyone', 'rights': 'Write', 'type': 'Allow'}]},
                 {**ok, 'aces': ok['aces'] + [{'identity': 'x'}]}, {**ok, 'reparse': True}, {'exists': False}, None]
        acl_url = (ROOT / '_shared' / 'acl_check.mjs').as_uri()
        js = (f"import {{ aclProblems }} from '{acl_url}'; let d=''; process.stdin.on('data', c => d += c)"
              ".on('end', () => console.log(JSON.stringify(JSON.parse(d).map((a) => aclProblems(a, 'x')))));")
        node = json.loads(subprocess.run([self.node, '--input-type=module', '-e', js], input=json.dumps(cases), capture_output=True, text=True, check=True).stdout)
        self.assertEqual(node, [core.acl_problems(a, 'x') for a in cases])


class OrgRegisterTests(unittest.TestCase):
    def reg(self, **over):
        rec = dict(org_registers.TEMPLATES['service'], **over)
        return {'schema_version': 1, 'records': [rec], 'history': []}

    def result(self, check_id, **over):
        r = org_registers.register_report('service', self.reg(**over), '2026-10-08')
        return next(c['result'] for c in r['checks'] if c['id'] == check_id)

    def test_domain_renewal_states(self):
        self.assertEqual(self.result('domain_main__renewal', renews_on='2026-09-30'), 'fail')  # lapsed
        self.assertEqual(self.result('domain_main__renewal', renews_on='2026-10-20', auto_renew=False), 'fail')
        self.assertEqual(self.result('domain_main__renewal', renews_on='2026-10-20', auto_renew=True), 'unresolved')
        self.assertEqual(self.result('domain_main__renewal', renews_on='2027-06-01'), 'pass')
        self.assertEqual(self.result('domain_main__renewal', renews_on=None), 'unresolved')

    def test_two_step_login(self):
        self.assertEqual(self.result('domain_main__mfa', mfa_enabled=False), 'fail')
        self.assertEqual(self.result('domain_main__mfa', mfa_enabled=True), 'pass')

    def test_update_keeps_history(self):
        reg = self.reg()
        new = dict(reg['records'][0], mfa_enabled=True)
        out = org_registers.register_update('service', reg, new)
        self.assertEqual(len(out['history']), 1)
        self.assertIsNone(out['history'][0]['previous']['mfa_enabled'])

    def test_rejects_unknown_service_type(self):
        with self.assertRaises(core.InputError):
            org_registers.validate_register('service', self.reg(service='crypto_wallet'))


class IncidentTimelineTests(unittest.TestCase):
    def test_example_incident_report(self):
        c = json.loads((ROOT / 'incident_timeline' / 'examples' / 'website_redirect.json').read_text())
        r = incident_timeline.incident(c)
        states = {x['id']: x['result'] for x in r['checks']}
        self.assertEqual(states['recognize'], 'pass')
        self.assertEqual(states['contain'], 'unresolved')
        self.assertEqual(r['environment'], 'incident_record')
        self.assertEqual(r['findings'][0]['unverified_events'], 4)

    def test_simulated_facts_only_in_exercises(self):
        c = {'id': 'x', 'scenario': 'domain_expiry', 'mode': 'real', 'decisions': {},
             'events': [{'at': '2026-10-08T00:00:00Z', 'stage': 'recognize', 'fact_status': 'simulated', 'reference': 'r'}]}
        with self.assertRaises(core.InputError):
            incident_timeline.incident(c)
        c['mode'] = 'exercise'
        self.assertEqual(incident_timeline.incident(c)['environment'], 'synthetic_tabletop')


class ScopeTests(Workspace):
    """Python tools that write files need a complete, open, unexpired scope that permits saving. The contract is
    scope_schema.json, shared with scope.mjs (F12)."""
    def scope(self, **over):
        s = {'incident_id': 'test', 'status': 'open', 'expires_at': '2099-01-01T00:00:00Z', 'persistence': 'local',
             'permissions': {'save_local': True}, 'question': 'q', 'scope': 's', 'stopping_condition': 'c',
             'targets': ['example.org'], 'urgency': 'normal', 'confidence': 'low', 'prohibited': ['p'],
             'disclosures': [], 'approvals': []}
        s.update(over)
        return self.put(f'scope-{uuid.uuid4().hex}.json', json.dumps(s))

    def test_require_scope_allows_an_open_local_scope(self):
        self.assertEqual(core.require_scope(self.scope())['incident_id'], 'test')

    def test_F12_incomplete_or_malformed_scopes_are_refused_like_node(self):
        for drop in ('incident_id', 'question', 'scope', 'stopping_condition', 'targets', 'prohibited', 'disclosures', 'urgency'):
            path = self.scope()
            data = json.loads(path.read_text()); del data[drop]; path.write_text(json.dumps(data))
            with self.assertRaises(core.InputError, msg=drop):
                core.require_scope(path)
        for over in (dict(targets=['not a target']), dict(disclosures=['nowhere']), dict(scope_schema=99),
                     dict(permissions={'save_local': True, 'teleport': True}),
                     dict(approvals=[{'action': 'publish', 'target': 'example.org', 'approved_at': '2026-10-09T00:00:00Z', 'approved_via': 'interactive_terminal'}])):
            with self.assertRaises(core.InputError, msg=str(over)):
                core.require_scope(self.scope(**over))

    def test_F12_node_and_python_read_the_same_schema(self):
        node = subprocess.run(['node', '--input-type=module', '-e',
                               "import { SCHEMA } from './_shared/scope.mjs'; console.log(JSON.stringify(SCHEMA))"],
                              cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(node.stdout), core.SCOPE_SCHEMA)

    def test_F12_python_target_key_matches_node(self):
        samples = ['example.org', 'www.Example.org.', 'https://user:pw@www.example.org:8443/x?y#z', 'sub.example.org/path',
                   'https://github.com/Owner/Repo/issues/1', 'https://github.com/owner', 'owner/repo', 'not a target',
                   'localhost', 'http://', 'ftp://files.example.org/', '']
        node = subprocess.run(['node', '--input-type=module', '-e',
                               "import { targetKey } from './_shared/scope.mjs';"
                               f"console.log(JSON.stringify({json.dumps(samples)}.map((s) => {{ const k = targetKey(s); return k && [k.type, k.key]; }})))"],
                              cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(node.stdout), [list(k) if k else None for k in map(core.target_key, samples)])

    def test_python_target_key_never_disagrees_with_node_over_generated_inputs(self):
        """Hundreds of generated inputs: Python must equal Node, or refuse (None). A DIFFERENT answer is a failure."""
        import itertools
        schemes = ['', 'https://', 'http://', 'HTTPS://', 'ftp://', 'https:///']
        userinfo = ['', 'user@', 'user:pw@', ':@']
        hosts = ['example.org', 'WWW.Example.ORG', 'www.example.org.', 'sub.example.co.uk', 'github.com', 'GitHub.com',
                 'localhost', 'example', '127.0.0.1', '10.0.0.1', '[::1]', 'exa_mple.org', '-bad.org', 'xn--bcher-kva.example',
                 'bücher.example', 'a.b', 'example.org..', '']
        ports = ['', ':443', ':8080', ':']
        paths = ['', '/', '/Owner/Repo', '/owner/repo/issues/1', '/owner', '?q=1', '#frag', '/a b']
        samples = set()
        for s, u, h, po, pa in itertools.product(schemes, userinfo, hosts, ports, paths):
            if s or not (u or po):  # without a scheme, only plain host + path forms make sense
                samples.add(f'{s}{u}{h}{po}{pa}')
        samples |= {'owner/repo', 'Owner/Repo', 'own.er/repo', 'owner/re.po', 'owner/repo/extra', ' example.org ', '\texample.org', 'owner/', '/repo'}
        samples = sorted(samples)
        self.assertGreater(len(samples), 500)
        node = subprocess.run(['node', '--input-type=module', '-e',
                               "import { targetKey } from './_shared/scope.mjs'; let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>"
                               "console.log(JSON.stringify(JSON.parse(d).map((s)=>{ const k = targetKey(s); return k && [k.type, k.key]; }))))"],
                              cwd=ROOT, input=json.dumps(samples), capture_output=True, text=True, check=True)
        node_keys = json.loads(node.stdout)
        disagree, stricter = [], []
        for s, n in zip(samples, node_keys):
            p = core.target_key(s)
            p = list(p) if p else None
            if p == n:
                continue
            if p is None:
                stricter.append(s)  # Python refuses what Node accepts: fail-closed; must be a documented kind (below)
            else:
                disagree.append((s, p, n))
        self.assertEqual(disagree, [], f'Python and Node disagree on {len(disagree)} input(s): {disagree[:5]}')
        # Python may be stricter ONLY for these documented kinds of input: non-ASCII names (Node converts them to
        # xn-- form) and "scheme:///host" URLs (Node's URL parser silently repairs the extra slash).
        unexplained = [s for s in stricter if s.isascii() and ':///' not in s]
        self.assertEqual(unexplained, [], f'Python refuses inputs Node accepts, for no documented reason: {unexplained[:5]}')

    def test_F12_a_stop_during_a_command_blocks_its_next_write(self):
        path = self.scope()
        core.require_scope(path)
        core.write_bytes_safely(self.tmp / 'first.txt', b'1')
        path.write_text(json.dumps({**json.loads(path.read_text()), 'status': 'stopped'}))
        with self.assertRaises(core.InputError):
            core.write_bytes_safely(self.tmp / 'second.txt', b'2')
        self.assertFalse((self.tmp / 'second.txt').exists())

    def test_require_scope_refusals(self):
        cases = [None, self.scope(status='stopped'), self.scope(expires_at='2020-01-01T00:00:00Z'),
                 self.scope(persistence='transient'), self.scope(permissions={'save_local': False}), self.scope(expires_at=None)]
        for path in cases:
            with self.assertRaises(core.InputError, msg=str(path)):
                core.require_scope(path)

    def test_emit_to_file_needs_a_scope_but_printing_does_not(self):
        result = core.report('t', [core.check('a', 'pass', 'x')])
        with self.assertRaises(core.InputError):
            core.emit(result, self.tmp / 'out.json')
        self.assertFalse((self.tmp / 'out.json').exists())
        self.assertEqual(core.emit(result, self.tmp / 'out.json', self.scope()), 0)
        self.assertTrue((self.tmp / 'out.json').exists())

    def test_tools_that_always_write_refuse_without_a_scope(self):
        src = self.put('in/shot.png', png_with_text())
        with self.assertRaises(SystemExit):  # argparse: --scope is required
            metadata_scrub.main([str(src)])
        with self.assertRaises(core.InputError):
            metadata_scrub.main([str(src), '--scope', str(self.scope(persistence='transient')), '--output-dir', str(self.tmp / 'o')])
        self.assertFalse((self.tmp / 'o').exists())


class AccessOffboardingTests(unittest.TestCase):
    def reg(self, *records):
        base = dict(access_offboarding.TEMPLATE['records'][0])
        return {'schema_version': 1, 'history': [], 'records': [dict(base, **r) for r in records]}

    def states(self, data):
        return {c['id']: c['result'] for c in access_offboarding.access_report(data, '2026-10-09')['checks']}

    def test_single_admin_is_a_lockout_risk_and_none_is_a_failure(self):
        one = self.reg({'id': 'a', 'system': 'domain_main'})
        self.assertEqual(self.states(one)['domain_main__managers'], 'unresolved')
        two = self.reg({'id': 'a', 'system': 'domain_main'}, {'id': 'b', 'role': 'treasurer', 'access_level': 'admin'})
        self.assertEqual(self.states(two)['domain_main__managers'], 'pass')
        none = self.reg({'id': 'a', 'access_level': 'editor'})
        self.assertEqual(self.states(none)['domain_main__managers'], 'fail')

    def test_admin_without_two_step_login_fails(self):
        self.assertEqual(self.states(self.reg({'id': 'a', 'mfa_enabled': False}))['a__mfa'], 'fail')
        self.assertEqual(self.states(self.reg({'id': 'a', 'mfa_enabled': None}))['a__mfa'], 'unresolved')

    def test_unneeded_active_access_fails_and_pending_removal_is_unresolved(self):
        s = self.states(self.reg({'id': 'a', 'still_needed': False}, {'id': 'b', 'role': 'x', 'state': 'pending_removal'}))
        self.assertEqual(s['a__remove'], 'fail')
        self.assertEqual(s['b__remove'], 'unresolved')

    def test_review_overdue(self):
        self.assertEqual(self.states(self.reg({'id': 'a', 'last_reviewed': '2025-01-01'}))['a__review'], 'unresolved')
        self.assertNotIn('a__review', self.states(self.reg({'id': 'a', 'last_reviewed': '2026-09-01'})))

    def test_offboarding_hands_over_control_before_removal(self):
        data = self.reg({'id': 'a', 'role': 'web_volunteer', 'system': 'domain_main'},
                        {'id': 'b', 'role': 'web_volunteer', 'system': 'website', 'access_level': 'editor'},
                        {'id': 'c', 'role': 'board_secretary', 'system': 'website', 'access_level': 'owner'})
        text = access_offboarding.offboard_checklist(data, 'web_volunteer')
        self.assertLess(text.index('FIRST confirm or establish another active owner/admin'), text.index("2. Remove this role's access"))
        self.assertIn('domain_main: verify an independent owner/admin', text)
        self.assertNotIn('website: verify an independent owner/admin', text)

    def test_no_existing_manager_is_never_described_as_safe_to_remove(self):
        data = self.reg({'id': 'viewer', 'role': 'outgoing_viewer', 'system': 'orphaned_system', 'access_level': 'viewer'})
        text = access_offboarding.offboard_checklist(data, 'outgoing_viewer')
        self.assertIn('orphaned_system: verify an independent owner/admin', text)
        self.assertIn('ALREADY have no active manager', text)
        self.assertNotIn('every system below has another owner/admin', text)

    def test_names_and_contact_details_are_refused(self):
        with self.assertRaises(core.InputError):
            access_offboarding.validate(self.reg({'id': 'a', 'role': 'jane@example.org'}))
        with self.assertRaises(core.InputError):
            access_offboarding.validate(self.reg({'id': 'a', 'access_level': 'god_mode'}))

    def test_update_keeps_history(self):
        data = self.reg({'id': 'a'})
        out = access_offboarding.register_update(data, dict(data['records'][0], state='removed'))
        self.assertEqual(out['history'][0]['previous']['state'], 'active')


def png_with_text():
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)
    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 0, 0, 0, 0)
    idat = zlib.compress(b'\x00\x00')
    return (metadata_scrub.PNG_SIG + chunk(b'IHDR', ihdr) + chunk(b'tEXt', b'Author\x00Jane Volunteer')
            + chunk(b'eXIf', b'MM\x00*') + chunk(b'IDAT', idat) + chunk(b'IEND', b''))


def jpeg_with_exif():
    seg = lambda m, payload: b'\xff' + bytes([m]) + struct.pack('>H', len(payload) + 2) + payload  # noqa: E731
    return (b'\xff\xd8' + seg(0xE0, b'JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00')
            + seg(0xE1, b'Exif\x00\x00GPS-LAT-40.7') + seg(0xFE, b'shot on volunteer phone')
            + seg(0xDB, b'\x00' + b'\x01' * 64) + b'\xff\xda\x00\x02' + b'\x12\x34' + b'\xff\xd9')


class MetadataScrubTests(Workspace):
    def test_png_text_and_exif_removed_pixels_kept(self):
        cleaned, removed = metadata_scrub.scrub_png(png_with_text())
        self.assertEqual(removed, ['tEXt', 'eXIf'])
        self.assertNotIn(b'Jane Volunteer', cleaned)
        self.assertIn(b'IDAT', cleaned)
        self.assertTrue(cleaned.endswith(b'IEND\xaeB`\x82'))

    def test_jpeg_exif_and_comment_removed_scan_kept(self):
        cleaned, removed = metadata_scrub.scrub_jpeg(jpeg_with_exif())
        self.assertEqual(removed, ['APP1', 'COM'])
        self.assertNotIn(b'GPS-LAT', cleaned)
        self.assertNotIn(b'volunteer phone', cleaned)
        self.assertIn(b'JFIF', cleaned)
        self.assertTrue(cleaned.endswith(b'\x12\x34\xff\xd9'))

    def test_run_never_touches_originals_and_skips_unknown_formats(self):
        src = self.put('in/shot.png', png_with_text())
        self.put('in/notes.txt', 'hello')
        before = src.read_bytes()
        out = metadata_scrub.run(self.tmp / 'in', self.tmp / 'out')
        self.assertEqual(src.read_bytes(), before)
        status = {r['file']: r['status'] for r in out['results']}
        self.assertEqual(status, {'notes.txt': 'skipped', 'shot.png': 'cleaned'})
        self.assertNotIn(b'Jane', (self.tmp / 'out' / 'shot.png').read_bytes())


if __name__ == '__main__':
    unittest.main()
