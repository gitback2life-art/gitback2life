"""Adapted copy of the second-round audit's Python adversarial suite
(original preserved unchanged at D:\\CRTS apps\\MY_tools\\gitback2life_audit_v2\\audit_adversarial.py).

Adaptations (see README.md in this folder):
  * ROOT is the working toolbox; fixtures live in a throwaway folder under .test_tmp, removed afterwards.
  * scope(): the original minimal four-field scope is kept as `minimal_scope()` for the F12 test (which expects it
    to be REJECTED). Tests that need a PERMITTING scope use a complete scope, because the F12 fix makes Python
    validate the same complete schema as Node.
  * F11: no file may be created outside the toolbox (session rule), so the escape is reproduced two ways:
    (a) the real CLI with a junction inside the toolbox (any junction in the output path must be refused);
    (b) the scrubber's run() with a stand-in toolbox root inside the throwaway folder and a junction to a sibling
        "outside" folder, which is exactly the escape the audit reproduced.
"""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import _winapi
import datetime, importlib.util, json, shutil, struct, subprocess, unittest, uuid, zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '_shared'))
import gb2l_core as core  # noqa: E402

spec = importlib.util.spec_from_file_location('scrub', ROOT / 'metadata_scrub' / 'metadata_scrub.py')
scrub = importlib.util.module_from_spec(spec); spec.loader.exec_module(scrub)
BASE = ROOT / '.test_tmp' / f'audit-py-{uuid.uuid4().hex}'
DIR = BASE / 'python'; DIR.mkdir(parents=True, exist_ok=True)


def minimal_scope():
    return dict(status='open', expires_at=(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)).isoformat(),
                permissions={'save_local': True}, persistence='local')


def scope():
    s = minimal_scope()
    s.update(incident_id='audit-py', question='q', scope='s', stopping_condition='c', targets=['alpha.example'],
             urgency='normal', confidence='low', prohibited=['p'], disclosures=[], approvals=[],
             created_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    return s


def save(name, value):
    p = DIR / name; p.write_text(json.dumps(value), encoding='utf8'); return p


def png():
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))  # noqa: E731
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\0\0\0\0')) + chunk(b'IEND', b'')


class Audit(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(BASE, ignore_errors=True)
        try:
            (ROOT / '.test_tmp').rmdir()
        except OSError:
            pass

    def test_F11a_metadata_scrub_cli_refuses_output_through_a_junction(self):
        target = DIR / 'junction-target'; target.mkdir(exist_ok=True)
        link = DIR / 'junction'
        if not link.exists():
            _winapi.CreateJunction(str(target), str(link))
        source = DIR / 'synthetic.png'; source.write_bytes(png())
        name = 'output-' + uuid.uuid4().hex
        r = subprocess.run([sys.executable, '-I', str(ROOT / 'metadata_scrub' / 'metadata_scrub.py'), str(source), '--output-dir', str(link / name),
                            '--scope', str(save('scope.json', scope()))], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse((target / name).exists(), 'output was created through the junction')

    def test_F11b_metadata_scrub_run_cannot_escape_the_toolbox_root_through_a_junction(self):
        box = BASE / 'box'; outside = BASE / 'outside' / 'metadata'
        box.mkdir(parents=True, exist_ok=True); outside.mkdir(parents=True, exist_ok=True)
        link = box / 'escape'
        if not link.exists():
            _winapi.CreateJunction(str(outside), str(link))
        source = DIR / 'synthetic-b.png'; source.write_bytes(png())
        name = 'output-' + uuid.uuid4().hex
        old_core, old_scrub = core.TOOLBOX_ROOT, scrub.TOOLBOX_ROOT
        core.TOOLBOX_ROOT = scrub.TOOLBOX_ROOT = box
        try:
            with self.assertRaises(core.InputError):
                scrub.run(source, link / name)
        finally:
            core.TOOLBOX_ROOT, scrub.TOOLBOX_ROOT = old_core, old_scrub
        self.assertFalse((outside / name).exists())

    def test_F12_python_rejects_incomplete_scope(self):
        with self.assertRaises(core.InputError):
            core.require_scope(save('incomplete.json', minimal_scope()))

    def test_F07_python_report_rejects_secret_metadata(self):
        out = DIR / 'report.json'
        if out.exists():
            out.unlink()
        core.emit({'result': 'pass', 'source_version': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'}, out, save('scope.json', scope()))
        self.assertNotIn('ghp_', out.read_text())

    def test_PASS_stopped_expired_permission_transient_refused(self):
        for change in [dict(status='stopped'), dict(expires_at='2000-01-01T00:00:00Z'), dict(permissions={}), dict(persistence='transient')]:
            with self.assertRaises(core.InputError):
                core.require_scope(save('negative.json', {**scope(), **change}))

    def test_PASS_core_rejects_existing_junction(self):
        target = DIR / 'j2-target'; target.mkdir(exist_ok=True)
        link = DIR / 'j2'
        if not link.exists():
            _winapi.CreateJunction(str(target), str(link))
        with self.assertRaises(core.InputError):
            core.no_links(link / 'new.txt')

    def test_PASS_backup_restore_scope_required(self):
        for cmd, args in [('backup', ['--input', 'fake.json', '--reviewed-manifest', 'fake.json', '--destination', 'fake']), ('restore', ['--backup', 'fake', '--destination', 'fake'])]:
            r = subprocess.run([sys.executable, '-I', str(ROOT / 'safe_backup' / 'safe_backup.py'), cmd, *args], capture_output=True, text=True)
            self.assertEqual(r.returncode, 2); self.assertIn('--scope', r.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
