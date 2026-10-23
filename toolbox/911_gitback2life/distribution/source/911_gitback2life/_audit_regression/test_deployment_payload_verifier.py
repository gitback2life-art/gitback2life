"""Offline tests only: all mutations occur in synthetic disposable source copies."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / 'authority' / 'deployment'
sys.path.insert(0, str(DEPLOY))
from verify_payload import verify, PayloadRefused, SOURCE_FILES


class PayloadSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = verify(ROOT)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='gb2l-inert-payload-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / '911_gitback2life'
        auth = self.root / 'authority'
        dest = auth / 'deployment'
        dest.mkdir(parents=True)
        for rel in SOURCE_FILES.values():
            origin = ROOT / 'authority' / Path(rel)
            target = auth / Path(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(origin, target)
        shutil.copytree(DEPLOY / 'payload', dest / 'payload')
        shutil.copyfile(DEPLOY / 'payload_manifest.json', dest / 'payload_manifest.json')
        shutil.copyfile(DEPLOY / 'verify_payload.py', dest / 'verify_payload.py')
        shutil.copyfile(DEPLOY / 'build_payload.py', dest / 'build_payload.py')
        self.payload = dest / 'payload'
        self.manifest = dest / 'payload_manifest.json'

    def check_refused(self, reason):
        with self.assertRaisesRegex(PayloadRefused, reason):
            verify(self.root)

    def test_baseline_and_clean_no_op_rebuild(self):
        self.assertEqual(verify(self.root)['verified_files'], 15)
        before = self.manifest.read_bytes()
        r = subprocess.run([sys.executable, str(self.manifest.parent / 'build_payload.py')],
                           text=True, capture_output=True, cwd=self.root)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(before, self.manifest.read_bytes())
        self.assertEqual(verify(self.root)['verified_files'], 15)

    def test_manifest_hash_unchanged_but_payload_tampered(self):
        target = self.payload / 'm3/cli.mjs'
        target.write_bytes(target.read_bytes() + b'\n// synthetic tamper\n')
        self.check_refused('source/payload divergence')

    def test_source_changed_without_rebuild_fails_closed_then_rebuilds(self):
        target = self.root / 'authority/m3/cli.mjs'
        target.write_bytes(target.read_bytes() + b'\n// synthetic change\n')
        self.check_refused('source/payload divergence')
        r = subprocess.run([sys.executable, str(self.manifest.parent / 'build_payload.py')],
                           text=True, capture_output=True, cwd=self.root)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(verify(self.root)['verified_files'], 15)

    def test_unknown_file_is_preserved_and_builder_refuses(self):
        target = self.payload / 'm3/unknown_evidence.txt'
        target.write_text('preserve me')
        self.check_refused('unlisted payload')
        r = subprocess.run([sys.executable, str(self.manifest.parent / 'build_payload.py')],
                           text=True, capture_output=True, cwd=self.root)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(target.read_text(), 'preserve me')

    def test_unlisted_symlinked_directory_is_rejected_without_traversing(self):
        outside = Path(self.tmp.name) / 'external'
        outside.mkdir()
        (outside / 'important.txt').write_text('unchanged')
        (self.payload / 'unsafe').symlink_to(outside, target_is_directory=True)
        self.check_refused('unlisted payload')
        r = subprocess.run([sys.executable, str(self.manifest.parent / 'build_payload.py')],
                           text=True, capture_output=True, cwd=self.root)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual((outside / 'important.txt').read_text(), 'unchanged')

    def test_expected_directory_replaced_by_symlink(self):
        moved = Path(self.tmp.name) / 'm2-real'
        (self.payload / 'm2').rename(moved)
        (self.payload / 'm2').symlink_to(moved, target_is_directory=True)
        self.check_refused('reparse point/symlink')

    def test_manifest_duplicate_case_or_extra_metadata(self):
        data = json.loads(self.manifest.read_text())
        data['files'][1]['path'] = 'M3/cli.mjs'
        self.manifest.write_text(json.dumps(data))
        self.check_refused('unexpected manifest path')
        data = json.loads((DEPLOY / 'payload_manifest.json').read_text())
        data['files'][0]['extra'] = True
        self.manifest.write_text(json.dumps(data))
        self.check_refused('unexpected manifest file metadata')

    def test_manifest_bytes_must_match(self):
        data = json.loads(self.manifest.read_text())
        data['files'][0]['bytes'] += 1
        self.manifest.write_text(json.dumps(data))
        self.check_refused('payload digest or byte count mismatch')

    def test_source_may_not_be_symlink(self):
        source = self.root / 'authority/m1/ledger.mjs'
        saved = source.with_name('ledger-source-original')
        source.rename(saved)
        source.symlink_to(saved)
        self.check_refused('reparse point/symlink')


if __name__ == '__main__':
    unittest.main()
