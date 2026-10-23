"""Read-only, bounded review of a client's own GB2L device-report ZIP.

No extraction, network requests, registry access, remote commands, or modifications.
The contents are untrusted and must not be treated as independently authenticated.
"""
import json
import os
from pathlib import Path
import re
import sys
import zipfile

IDS = (
    'malware_protection', 'signature_freshness', 'system_disk_encryption',
    'firewall', 'machine_lock_policy', 'effective_screen_lock', 'supported_updates',
)
DESCRIPTIONS = {
    'malware_protection': 'Antivirus protection',
    'signature_freshness': 'Antivirus definitions',
    'system_disk_encryption': 'System drive encryption',
    'firewall': 'Windows Firewall',
    'machine_lock_policy': 'Automatic screen locking policy',
    'effective_screen_lock': 'Sign-in required after locking',
    'supported_updates': 'Supported Windows and updates',
}
MAX_REPORT = 32 * 1024
MAX_ARCHIVE = 512 * 1024


def check_report(obj):
    if not isinstance(obj, dict) or set(obj) != {
        'schema_version', 'tool_version', 'tool', 'observed_at', 'source_version',
        'environment', 'result', 'checks',
    }:
        raise ValueError('unexpected report fields (report may contain more data than intended)')
    if type(obj['schema_version']) is not int or obj['schema_version'] != 1:
        raise ValueError('unsupported report version')
    if obj['tool'] != 'device' or obj['environment'] != 'local_device' or obj['source_version'] != 'device-status-v1':
        raise ValueError('not a client-device security status report')
    if not isinstance(obj['tool_version'], str) or not re.fullmatch(r'[0-9.]{1,16}', obj['tool_version']):
        raise ValueError('unrecognized device-status version')
    if not isinstance(obj['observed_at'], str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})', obj['observed_at']):
        raise ValueError('missing valid collection timestamp')
    rows = obj['checks']
    if not isinstance(rows, list) or len(rows) != len(IDS):
        raise ValueError('incorrect number of security checks')
    statuses = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'id', 'result', 'category', 'reference'}:
            raise ValueError('unrecognized check fields')
        identifier = row['id']
        if not isinstance(identifier, str) or identifier not in IDS or identifier in seen:
            raise ValueError('unknown or duplicated security check')
        seen.add(identifier)
        if row['result'] not in ('pass', 'fail', 'unresolved'):
            raise ValueError('invalid check outcome')
        if not isinstance(row['category'], str) or not re.fullmatch(r'[a-z0-9_]{1,90}', row['category']):
            raise ValueError('unexpected category')
        if row['reference'] is not None:
            raise ValueError('unexpected extra evidence reference')
        statuses.append(row['result'])
    if set(IDS) != seen:
        raise ValueError('incomplete security checks')
    overall = 'fail' if 'fail' in statuses else ('unresolved' if 'unresolved' in statuses else 'pass')
    if obj['result'] != overall:
        raise ValueError('report summary contradicts its checks')
    return obj


def read_report(archive_path):
    path = Path(archive_path).expanduser()
    if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_ARCHIVE:
        raise ValueError('choose an ordinary client ZIP no larger than 512 KB')
    with zipfile.ZipFile(path, 'r') as archive:
        entries = archive.infolist()
        if len(entries) != 1 or entries[0].filename != 'DEVICE_REPORT.json':
            raise ValueError('expected a client report ZIP containing only DEVICE_REPORT.json')
        entry = entries[0]
        if entry.is_dir() or entry.flag_bits & 1 or entry.file_size > MAX_REPORT or entry.compress_size > MAX_ARCHIVE:
            raise ValueError('client report is oversized, encrypted or invalid')
        with archive.open(entry, 'r') as handle:
            raw = handle.read(MAX_REPORT + 1)
        if len(raw) > MAX_REPORT:
            raise ValueError('client report is oversized')
        report = json.loads(raw.decode('utf-8-sig'))
    return check_report(report)


def format_report(report):
    out = [
        'CLIENT COMPUTER SECURITY CHECK — read-only report',
        f"Collected at: {report['observed_at']}",
        'Source: Client-provided file; not independently authenticated.',
        'No remote connection, malware scan, passwords or full inventory were collected.',
        '',
    ]
    for row in report['checks']:
        outcome = {'pass': 'PASS', 'fail': 'NEEDS ATTENTION', 'unresolved': 'NOT VERIFIED'}[row['result']]
        out.append(f"  {DESCRIPTIONS[row['id']]}: {outcome}")
        if row['result'] != 'pass':
            out.append('    Explanation: ' + row['category'].replace('_', ' '))
    out.append('')
    out.append('Overall: ' + {'pass': 'PASS', 'fail': 'NEEDS ATTENTION', 'unresolved': 'NOT FULLY VERIFIED'}[report['result']])
    out.append('Use these findings to advise the organization. This tool makes no system changes.')
    return '\n'.join(out)


def main(argv):
    if len(argv) != 2:
        print('Usage: review_client_report.py CLIENT_DEVICE_REPORT.zip', file=sys.stderr)
        return 2
    try:
        print(format_report(read_report(argv[1])))
        return 0
    except (OSError, ValueError, KeyError, TypeError, UnicodeError, zipfile.BadZipFile, RuntimeError) as exc:
        print('Client report refused: ' + str(exc), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
