"""Strict, read-only, OFFLINE check of predeployment source and its inert payload.

Does not need elevation, inspect the authority installation, or enable any commands.
This verifies self-consistency, NOT owner trust, Windows ACLs, or installer readiness.
"""
import argparse
import hashlib
import json
import os
import stat
from pathlib import Path

SCHEMA = 'gb2l-predeploy-v1'
# Explicit allowed source closure: do not silently add a new executable module
# merely because an extra .mjs file appears in a source directory.
SOURCE_FILES = {
    'authority.cmd': 'g0a/launcher/authority.cmd',
    'bootstrap.mjs': 'deployment/bootstrap_predeployment.mjs',
    'g0a/exclusive_lock.mjs': 'g0a/exclusive_lock.mjs',
    'g0a/request_pipe.mjs': 'g0a/request_pipe.mjs',
    'm1/engine.mjs': 'm1/engine.mjs',
    'm1/ledger.mjs': 'm1/ledger.mjs',
    'm2/commands.mjs': 'm2/commands.mjs',
    'm2/masking.mjs': 'm2/masking.mjs',
    'm2/register_rules.mjs': 'm2/register_rules.mjs',
    'm2/renderer.mjs': 'm2/renderer.mjs',
    'm3/cli.mjs': 'm3/cli.mjs',
    'm3/exporter.mjs': 'm3/exporter.mjs',
    'm3/fs_backend.mjs': 'm3/fs_backend.mjs',
    'm3/offline_readiness.mjs': 'm3/offline_readiness.mjs',
    'm3/owner_console.mjs': 'm3/owner_console.mjs',
    'm3/signer.mjs': 'm3/signer.mjs',
    'm3/tree.mjs': 'm3/tree.mjs',
}


class PayloadRefused(ValueError):
    pass


def refuse(why):
    raise PayloadRefused('payload verification refused: ' + why)


def ordinary(path, directory=False):
    """lstat: do not traverse links, junctions, or hard-linked files."""
    try:
        st = path.lstat()
    except FileNotFoundError:
        refuse('missing ' + str(path))
    if (stat.S_ISLNK(st.st_mode) or
            (getattr(st, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0))):
        refuse('reparse point/symlink at ' + str(path))
    if directory:
        if not stat.S_ISDIR(st.st_mode):
            refuse('not a directory: ' + str(path))
    elif not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        refuse('not an ordinary single-link file: ' + str(path))


def inspect_payload_tree(payload):
    """Reject undisclosed files, directory links, and casefold collisions before reading bytes."""
    ordinary(payload, directory=True)
    found = set()
    seen_folded = set()
    expected = set(SOURCE_FILES)
    directories = {rel.split('/')[0] for rel in expected if '/' in rel}
    stack = [(payload, '')]
    while stack:
        folder, prefix = stack.pop()
        ordinary(folder, directory=True)
        for item in folder.iterdir():
            rel = f'{prefix}/{item.name}'.lstrip('/')
            # On Windows distinct spellings can address the *same* on-disk target.
            folded = rel.casefold()
            if folded in seen_folded:
                refuse('case-insensitive duplicate path: ' + rel)
            seen_folded.add(folded)
            if '/' not in rel and rel in directories:
                ordinary(item, directory=True)
                stack.append((item, rel))
            elif rel in expected:
                ordinary(item)
                found.add(rel)
            else:
                refuse('unlisted payload path: ' + rel)
    if found != expected:
        refuse('payload paths missing: ' + ', '.join(sorted(expected - found)))


def verify(project_root):
    root = Path(os.path.abspath(project_root))
    ordinary(root, directory=True)
    auth = root / 'authority'
    deploy = auth / 'deployment'
    ordinary(auth, directory=True)
    ordinary(deploy, directory=True)
    manifest_path = deploy / 'payload_manifest.json'
    ordinary(manifest_path)
    try:
        manifest = json.loads(manifest_path.read_bytes())
    except (ValueError, UnicodeDecodeError) as exc:
        refuse('invalid JSON manifest: ' + str(exc))
    if not isinstance(manifest, dict) or set(manifest) != {'schema', 'files'} or manifest['schema'] != SCHEMA:
        refuse('unsupported manifest schema or fields')
    records = manifest['files']
    if not isinstance(records, list) or len(records) != len(SOURCE_FILES):
        refuse('wrong manifest file count')
    seen, seen_folded = set(), set()
    for record in records:
        if not isinstance(record, dict) or set(record) != {'path', 'sha256', 'bytes'}:
            refuse('unexpected manifest file metadata')
        rel, digest, size = record['path'], record['sha256'], record['bytes']
        if not isinstance(rel, str) or rel not in SOURCE_FILES:
            refuse('unexpected manifest path: ' + repr(rel))
        if rel in seen or rel.casefold() in seen_folded:
            refuse('duplicate or case-insensitive colliding manifest entry: ' + rel)
        seen.add(rel)
        seen_folded.add(rel.casefold())
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            refuse('invalid SHA-256 field: ' + rel)
        if type(size) is not int or size < 0:
            refuse('invalid byte count: ' + rel)
    if seen != set(SOURCE_FILES):
        refuse('manifest does not list the full fixed source closure')
    payload = deploy / 'payload'
    inspect_payload_tree(payload)
    checked = []
    for record in records:
        rel = record['path']
        source = auth.joinpath(*SOURCE_FILES[rel].split('/'))
        target = payload.joinpath(*rel.split('/'))
        ordinary(source.parent, directory=True)
        ordinary(source)
        source_bytes = source.read_bytes()
        payload_bytes = target.read_bytes()
        if source_bytes != payload_bytes:
            refuse('source/payload divergence: ' + rel)
        if len(payload_bytes) != record['bytes'] or hashlib.sha256(payload_bytes).hexdigest() != record['sha256']:
            refuse('payload digest or byte count mismatch: ' + rel)
        checked.append(rel)
    # This is intentionally a source-only candidate: a valid hash is not a trust root.
    # The installed bootstrap has to be reviewed independently after Windows/owner gates.
    return {'status': 'source_payload_consistent_only', 'verified_files': len(checked),
            'not_authorized': ['install', 'elevation', 'genesis', 'M4', 'G0b', 'G2']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2],
                        help='source project root; never a protected authority path')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.root), sort_keys=True))
    except PayloadRefused as exc:
        parser.exit(2, str(exc) + '\n')
