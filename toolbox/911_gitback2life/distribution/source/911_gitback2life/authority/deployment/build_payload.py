"""Build the INACTIVE source payload for offline review. Never installs/elevates.

Safety: refuse unknown payload files, links, or directory names; do not recursively
remove any source tree. Write each changed file atomically, manifest last. A crash
can produce a mismatched manifest, which the verifier will reject until rebuilt.
"""
import hashlib
import json
import os
import tempfile
from pathlib import Path

from verify_payload import SOURCE_FILES, SCHEMA, PayloadRefused, ordinary

BASE = Path(__file__).resolve().parent
AUTH = BASE.parent
PAYLOAD = BASE / 'payload'


def check_existing_tree():
    if not PAYLOAD.exists() and not PAYLOAD.is_symlink():
        PAYLOAD.mkdir()  # only the known output directory
        return
    ordinary(PAYLOAD, directory=True)
    known_dirs = {p.split('/')[0] for p in SOURCE_FILES if '/' in p}
    for path in PAYLOAD.iterdir():
        if path.name in known_dirs:
            ordinary(path, directory=True)
            for child in path.iterdir():
                if f'{path.name}/{child.name}' not in SOURCE_FILES:
                    raise PayloadRefused('unknown payload child preserved: ' + str(child))
                ordinary(child)
        elif path.name in SOURCE_FILES:
            ordinary(path)
        else:
            raise PayloadRefused('unknown payload entry preserved: ' + str(path))


def atomic_bytes(path, data):
    fd, tmp = tempfile.mkstemp(prefix='.gb2l-temp-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def build():
    check_existing_tree()
    entries = []
    for name, relative_source in sorted(SOURCE_FILES.items()):
        source = AUTH.joinpath(*relative_source.split('/'))
        ordinary(source.parent, directory=True)
        ordinary(source)
        content = source.read_bytes()
        target = PAYLOAD.joinpath(*name.split('/'))
        if target.parent != PAYLOAD and not target.parent.exists():
            target.parent.mkdir()
        if target.exists():
            ordinary(target)
        if not target.exists() or target.read_bytes() != content:
            atomic_bytes(target, content)
        entries.append({'path': name, 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
    manifest = json.dumps({'schema': SCHEMA, 'files': entries}, indent=2) + '\n'
    atomic_bytes(BASE / 'payload_manifest.json', manifest.encode('utf-8'))
    from verify_payload import verify
    return verify(AUTH.parent)


if __name__ == '__main__':
    print(json.dumps(build(), sort_keys=True))
