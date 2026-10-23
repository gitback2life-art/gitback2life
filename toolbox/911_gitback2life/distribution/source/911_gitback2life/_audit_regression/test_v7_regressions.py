# v7 regressions (Python side). The image rule used by backups: a backup keeps an image byte-for-byte only when it
# has nothing beyond its core parts, so the stored digest is the source digest; anything else is refused, not
# "cleaned". Also: the JPEG rebuild (V6-02) and the pinned PowerShell for ACL reads (V6-03).
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import unittest, struct, zlib, json
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '_shared'))
import gb2l_core as core

SECRET = b'ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01'
def chunk(kind, data): return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
def png(*extra): return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + b''.join(extra)
                         + chunk(b'IDAT', zlib.compress(b'\0\1\2\3')) + chunk(b'IEND', b''))


class BackupImageRule(unittest.TestCase):
    def test_a_core_only_image_is_kept_byte_for_byte(self):
        self.assertEqual(core.prepare_for_storage(png(), binary='image', require_unchanged=True), png())

    def test_hidden_chunks_or_trailers_are_refused_for_backups_and_removed_otherwise(self):
        for bad in (png(chunk(b'raNd', SECRET)), png(chunk(b'iCCP', b'icc\0\0' + SECRET))):
            with self.assertRaises(core.InputError):
                core.prepare_for_storage(bad, binary='image', require_unchanged=True)
            self.assertNotIn(SECRET, core.prepare_for_storage(bad, binary='image'))
        for bad in (png() + SECRET, png()[:-3]):
            with self.assertRaises(core.InputError):
                core.prepare_for_storage(bad, binary='image')

    def test_known_metadata_is_refused_with_the_scrub_instruction(self):
        with self.assertRaises(core.InputError) as cm:
            core.prepare_for_storage(png(chunk(b'tEXt', b'k\0' + SECRET)), binary='image')
        self.assertIn('metadata_scrub', str(cm.exception))


def seg(marker, body): return bytes([0xFF, marker]) + struct.pack('>H', len(body) + 2) + body
SOF = seg(0xC0, bytes([8, 0, 1, 0, 1, 1, 1, 0x11, 0]))
DQT = seg(0xDB, b'\0' + b'\1' * 64)
SOS = seg(0xDA, bytes([1, 1, 0, 0, 63, 0]))
SCAN = bytes([0x12, 0x34, 0xFF, 0x00, 0x56])


class JpegRebuild(unittest.TestCase):
    def test_metadata_after_the_scan_starts_is_dropped_and_trailers_refused(self):
        hidden = (b'\xff\xd8' + seg(0xE2, b'ICC_PROFILE\0' + SECRET) + DQT + SOF + SOS + SCAN
                  + seg(0xE1, SECRET) + seg(0xFE, SECRET) + SOS + SCAN + b'\xff\xd9')
        out = core.sanitize_image(hidden)
        self.assertNotIn(SECRET, out)
        self.assertEqual(core.sanitize_image(out), out)
        with self.assertRaises(core.InputError):
            core.sanitize_image(b'\xff\xd8' + DQT + SOF + SOS + SCAN + b'\xff\xd9' + SECRET)


class PinnedPowerShell(unittest.TestCase):
    def test_python_acl_reads_use_the_pinned_path_and_a_constructed_environment(self):
        import os
        calls = []
        class Done:
            returncode, stdout = 0, '{}'
        def run(args, **kw):
            calls.append((args, kw)); return Done()
        saved = os.environ.get('PATH')
        os.environ['PATH'] = r'C:\poisoned;' + (saved or '')
        try:
            core._read_acls([r'C:\x'], run=run)
        finally:
            os.environ['PATH'] = saved
        args, kw = calls[0]
        self.assertEqual(args[0], r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
        self.assertEqual(args[1:4], ['-NoProfile', '-NonInteractive', '-Command'])
        self.assertEqual(kw['env'], core.trusted_env())
        self.assertEqual(kw['cwd'], r'C:\Windows\System32')
        self.assertNotIn('poisoned', json.dumps(kw['env']))


class UpdatesAreDisabled(unittest.TestCase):
    """V7-01: until approval enforcement exists, update commands validate the change and then refuse to write."""
    def run_update(self, tool, data, record, extra):
        import subprocess, tempfile, shutil
        parent = ROOT / '.test_tmp'; parent.mkdir(exist_ok=True)
        d = Path(tempfile.mkdtemp(prefix='v7-update-', dir=parent))
        try:
            (d / 'register.json').write_text(json.dumps(data)); (d / 'record.json').write_text(json.dumps(record))
            before = (d / 'register.json').read_bytes()
            r = subprocess.run([sys.executable, '-I', str(ROOT / tool / f'{tool}.py'), 'update', *extra, '--register', str(d / 'register.json'),
                                '--record', str(d / 'record.json')], capture_output=True, text=True)
            self.assertEqual((d / 'register.json').read_bytes(), before, 'register unchanged')
            self.assertEqual(sorted(p.name for p in d.iterdir()), ['record.json', 'register.json'], 'nothing else written')
            return r
        finally:
            shutil.rmtree(d, ignore_errors=True)
            try: parent.rmdir()
            except OSError: pass

    def load_tool(self, name):
        import importlib.util
        spec = importlib.util.spec_from_file_location(name, ROOT / name / f'{name}.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        return m

    def test_a_valid_change_is_refused_for_lack_of_approval_and_names_its_hash(self):
        org, access = self.load_tool('org_registers'), self.load_tool('access_offboarding')
        rec = dict(org.TEMPLATES['service'])
        r = self.run_update('org_registers', {'schema_version': 1, 'records': [rec], 'history': []}, {**rec, 'provider': 'Synthetic replacement'}, ['--kind', 'service'])
        self.assertEqual(r.returncode, 2)
        self.assertIn('update is disabled', r.stderr); self.assertRegex(r.stderr, r'sha256 [0-9a-f]{64}')
        data = json.loads(json.dumps(access.TEMPLATE))
        r = self.run_update('access_offboarding', data, {**data['records'][0], 'state': 'removed'}, [])
        self.assertEqual(r.returncode, 2); self.assertIn('update is disabled', r.stderr)

    def test_an_invalid_change_still_gets_its_validation_error(self):
        org = self.load_tool('org_registers')
        rec = dict(org.TEMPLATES['service'])
        r = self.run_update('org_registers', {'schema_version': 1, 'records': [rec], 'history': []}, {**rec, 'unexpected_field': 1}, ['--kind', 'service'])
        self.assertEqual(r.returncode, 2); self.assertNotIn('update is disabled', r.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
