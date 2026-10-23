# Adapted copy of the v8 independent review's Python checks (original: audit_2026-10-11_current\snapshot\
# independent_v8_python.py, preserved unchanged). Adaptations: ROOT is the working toolbox; the input fixtures are the
# reviewer's two evidence files (snapshot\unused-*.png, copied byte-for-byte into _audit_regression/fixtures/v8/; they
# are what the original Node test saved on v8, and still carry the synthetic token); outputs are removed in tearDown.
# Assertions unchanged.
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import unittest
ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'v8'
sys.path.insert(0, str(ROOT / '_shared'))
import gb2l_core as core
SECRET = b'ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01'

class PalettePersistence(unittest.TestCase):
    def tearDown(self):
        for location in ('palette', 'transparency'):
            (ROOT / '.test_tmp' / f'python-unused-{location}.png').unlink(missing_ok=True)
        try: (ROOT / '.test_tmp').rmdir()
        except OSError: pass
    def check_entry(self, location):
        data = (FIXTURES / f'unused-{location}.png').read_bytes()
        self.assertIn(SECRET, data)  # adaptation-only sanity check: the fixture really carries the token
        self.assertEqual(core.parse_png(data)['rows'], b'\0\xff')
        target = ROOT / '.test_tmp' / f'python-unused-{location}.png'
        target.parent.mkdir(exist_ok=True)
        core.write_bytes_safely(target, data, binary='image')
        self.assertNotIn(SECRET, target.read_bytes())
    def test_unused_palette(self): self.check_entry('palette')
    def test_unused_transparency(self): self.check_entry('transparency')

if __name__ == '__main__': unittest.main(verbosity=2)
