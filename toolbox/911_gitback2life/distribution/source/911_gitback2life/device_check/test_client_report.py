"""Offline, synthetic client report safety and usability checks."""
import copy
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from review_client_report import IDS, check_report, format_report, read_report


def sample():
    return {
        'schema_version': 1, 'tool_version': '1.1.0', 'tool': 'device',
        'observed_at': '2026-10-20T12:34:56.123Z', 'source_version': 'device-status-v1',
        'environment': 'local_device', 'result': 'unresolved',
        'checks': [
            {'id': identifier, 'result': 'unresolved', 'category': 'manual_review', 'reference': None}
            for identifier in IDS
        ],
    }


class ClientDeviceReportTests(unittest.TestCase):
    def test_reads_genuine_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'sample.zip'
            with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as z:
                z.writestr('DEVICE_REPORT.json', json.dumps(sample()))
            report = read_report(target)
            rendered = format_report(report)
            self.assertIn('CLIENT COMPUTER SECURITY CHECK', rendered)
            self.assertIn('NOT FULLY VERIFIED', rendered)
            self.assertIn('not independently authenticated', rendered)

    def test_detects_inconsistent_overall_status(self):
        wrong = sample()
        wrong['result'] = 'pass'
        with self.assertRaisesRegex(ValueError, 'contradicts'):
            check_report(wrong)

    def test_rejects_extra_sensitive_field(self):
        wrong = sample()
        wrong['hostname'] = 'secret'
        with self.assertRaisesRegex(ValueError, 'unexpected report fields'):
            check_report(wrong)

    def test_rejects_incomplete_and_duplicate_checks(self):
        wrong = sample()
        wrong['checks'][1] = copy.deepcopy(wrong['checks'][0])
        with self.assertRaisesRegex(ValueError, 'duplicated'):
            check_report(wrong)

    def test_rejects_extraneous_zip_member(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'sample.zip'
            with zipfile.ZipFile(target, 'w') as z:
                z.writestr('DEVICE_REPORT.json', json.dumps(sample()))
                z.writestr('../../extraneous.txt', 'text')
            with self.assertRaisesRegex(ValueError, 'only DEVICE_REPORT'):
                read_report(target)

    def test_rejects_oversized_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'sample.zip'
            with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as z:
                z.writestr('DEVICE_REPORT.json', 'x' * 40000)
            with self.assertRaisesRegex(ValueError, 'oversized'):
                read_report(target)


if __name__ == '__main__':
    unittest.main()
