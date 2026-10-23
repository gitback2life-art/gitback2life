"""code_flow_scan: find where a website's code stores, logs, or sends data, and flag absolute privacy/security claims.

Adapted from the gitback2life security suite content-flow and disclosure scanners. Reads only files you
explicitly select under an explicit root; never prints source snippets in reports. Findings are heuristic
leads for human review, not proof.

  python code_flow_scan.py discover --root DIR [--output FILE]   propose a selection (review it before scanning)
  python code_flow_scan.py scan --input config.json [--output FILE]
  python code_flow_scan.py disclosure --input config.json [--output FILE]

config.json: {"root": "...", "files": ["src/a.js", ...], "source_version": "commit-or-label",
              "suppressions": [optional], "claims": [optional, disclosure only]}
"""
import argparse
import datetime as dt
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True  # no __pycache__ files in the toolkit
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '_shared'))
from gb2l_core import (InputError, check, cli, digest, emit, identifier, keys, label, load, metadata_path,
                       relative, report, require, selected)

FLOW_RULES = {
    'storage': r'\b(localStorage|sessionStorage|indexedDB|writeFile|appendFile|write_text|write_bytes|INSERT\s+INTO)\b',
    'outbound': r'\b(fetch|axios|requests\.(?:post|get)|https?\.request|sendBeacon|XMLHttpRequest)\s*\(',
    'logging': r'\b(console\.(?:log|error|warn|debug)|logger\.\w+|logging\.\w+|print)\s*\(',
    'background': r'\b(waitUntil|setInterval|setTimeout|create_task|queue\.send)\s*\(',
    'third_party_script': r'<script[^>]+src=["\']https?://',
    'form_post': r'<form[^>]+action=["\']https?://',
}
DISCLOSURE_RULES = {
    'absolute_privacy': r'\b(nothing.*(?:stored|logged)|never\s+(?:store|log|share)|zero\s+retention|no\s+data.*retained)\b',
    'absolute_security': r'\b(100%\s+secure|completely\s+secure|guaranteed\s+security|fully\s+anonymous|unhackable)\b',
}
SCAN_SUFFIXES = {'.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.json', '.jsonc', '.toml', '.md', '.html', '.htm',
                 '.txt', '.css', '.php', '.liquid', '.njk', '.yml', '.yaml'}
SKIP = {'node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.next'}


def discover(root):
    root = metadata_path(root).resolve()
    require(root.is_dir(), 'root must be a folder')
    files = []
    for p in sorted(root.rglob('*')):
        rel = p.relative_to(root).as_posix()
        if any(part in SKIP for part in p.relative_to(root).parts) or not p.is_file() or p.is_symlink():
            continue
        if p.suffix.lower() not in SCAN_SUFFIXES or p.stat().st_size > 1_000_000:
            continue
        try:
            relative(rel)
        except InputError:
            continue  # sensitive-looking names are left out; add them by hand only if you are sure
        files.append(rel)
        if len(files) >= 2000:
            break
    return {'root': str(root), 'files': files, 'source_version': 'set-me-to-the-commit-or-snapshot-you-reviewed'}


def scan(config, disclosure=False):
    keys(config, {'root', 'files', 'source_version'}, {'suppressions', 'claims'})
    require(isinstance(config['files'], list) and 0 < len(config['files']) <= 2000, 'files must list 1-2000 paths')
    rules = DISCLOSURE_RULES if disclosure else FLOW_RULES
    suppressions = config.get('suppressions', [])
    for s in suppressions:
        keys(s, {'file', 'line', 'rule', 'reason', 'review_date'})
        relative(s['file']); identifier(s['rule']); label(s['reason'])
        dt.date.fromisoformat(s['review_date'])
    findings, fingerprints, checks = [], [], []
    total = 0
    today = dt.datetime.now(dt.timezone.utc).date()
    for value in config['files']:
        path = selected(config['root'], value)
        require(path.suffix.lower() in SCAN_SUFFIXES, f'Unsupported file type: {value}')
        size = path.stat().st_size
        require(size <= 1_000_000, f'File too large: {value}')
        total += size
        require(total <= 20_000_000, 'Total scan budget exceeded')
        text = path.read_text(encoding='utf-8', errors='replace')
        fingerprints.append({'file': value, 'sha256': digest(path)})
        for line_number, line in enumerate(text.splitlines(), 1):
            for rule, pattern in rules.items():
                if re.search(pattern, line, re.I):
                    suppressed = any(s['file'] == value and s['line'] == line_number and s['rule'] == rule and
                                     dt.date.fromisoformat(s['review_date']) >= today for s in suppressions)
                    findings.append(dict(file=value, line=line_number, rule=rule, confidence='heuristic',
                                         disposition='reviewed_suppression' if suppressed else 'needs_review'))
    if disclosure:
        by_subject = {}
        for claim in config.get('claims', []):
            keys(claim, {'subject', 'value', 'reference', 'verified'})
            subject = identifier(claim['subject']); label(claim['value']); label(claim['reference'])
            require(type(claim['verified']) is bool)
            by_subject.setdefault(subject, []).append(claim)
        for subject, group in by_subject.items():
            checks.append(check(subject, 'fail' if len({g['value'] for g in group}) > 1 else
                                ('pass' if all(g['verified'] for g in group) else 'unresolved'), 'claim_comparison'))
    checks.append(check('human_review', 'unresolved', 'static_scan_not_proof'))
    return report('disclosure' if disclosure else 'content_flow', checks, config['source_version'],
                  findings=findings, fingerprints=fingerprints)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)
    d = sub.add_parser('discover'); d.add_argument('--root', required=True, type=Path); d.add_argument('--output', type=Path); d.add_argument('--scope', type=Path)
    for name in ('scan', 'disclosure'):
        s = sub.add_parser(name); s.add_argument('--input', required=True, type=Path); s.add_argument('--output', type=Path); s.add_argument('--scope', type=Path)
    args = p.parse_args(argv)
    if args.command == 'discover':
        proposal = discover(args.root)
        print(f'{len(proposal["files"])} candidate file(s). Review the list, then set source_version before scanning.', file=sys.stderr)
        return emit(proposal, args.output, args.scope) and 0
    return emit(scan(load(args.input), args.command == 'disclosure'), args.output, args.scope)


if __name__ == '__main__':
    cli(main)
