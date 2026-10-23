"""safe_backup: back up an organization's site or data files BEFORE anyone changes anything, and restore safely.

Adapted from the gitback2life security suite allowlisted backup/restore tool.
  1. preview: hash an explicit list of files under a root. Review the manifest it prints.
  2. backup:  copy exactly those files to a NEW folder, refusing if anything changed since the preview.
  3. restore: verify every hash, then copy into a NEW folder (never overwrites).
Backups and restores go inside this toolbox folder. Existing folders are never overwritten.

  python safe_backup.py preview --input selection.json [--output manifest.json]
  python safe_backup.py backup  --input selection.json --reviewed-manifest manifest.json --destination DIR
  python safe_backup.py restore --backup DIR --destination DIR

selection.json: {"root": "...", "files": ["index.html", "data/orgs.json"], "exclude": ["data/private"],
                 "source_version": "label"}
"""
import argparse
from pathlib import Path
import sys

sys.dont_write_bytecode = True  # no __pycache__ files in the toolkit
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '_shared'))
from gb2l_core import (check, cli, digest, emit, inside_toolbox, keys, label, load, make_dirs, no_links, report, require,
                       require_scope, selected, write, write_bytes_safely)


def excluded(name, exclude):
    require(all(isinstance(x, str) and x for x in exclude))
    return any(name.casefold() == x.casefold() or name.casefold().startswith(x.rstrip('/').casefold() + '/') for x in exclude)


def preview(c):
    keys(c, {'root', 'files', 'exclude', 'source_version'})
    require(isinstance(c['files'], list) and 0 < len(c['files']) <= 1000, 'files must list 1-1000 paths')
    require(isinstance(c['exclude'], list))
    require(len({x.casefold() for x in c['files']}) == len(c['files']), 'Duplicate file entries')
    files, total = [], 0
    for name in c['files']:
        require(not excluded(name, c['exclude']), f'Selection conflicts with exclusion: {name}')
        path = selected(c['root'], name)
        size = path.stat().st_size
        total += size
        require(size <= 10_000_000 and total <= 100_000_000, 'Backup size budget exceeded')
        files.append(dict(file=name, bytes=size, sha256=digest(path)))
    return {'schema_version': 1, 'source_version': label(c['source_version']), 'files': files}


def backup(c, destination, expected_manifest):
    manifest = preview(c)
    require(manifest == expected_manifest, 'Source changed since the reviewed preview')
    destination = no_links(inside_toolbox(destination))
    require(not destination.exists(), 'Backup destination must be new')
    root = no_links(c['root']).resolve()
    require(not destination.resolve().is_relative_to(root), 'Backup must be outside the source root')
    make_dirs(destination)
    for item in manifest['files']:
        source = selected(root, item['file'])
        target = destination / 'files' / item['file']
        # #10: a backup must be exact, so a file is kept only if it is ALREADY masked (masking would change nothing);
        # images only without metadata; other binary is refused. Written through the shared safe writer (link checks,
        # real-location check), not shutil.
        write_bytes_safely(target, source.read_bytes(), binary='image', require_unchanged=True)
        require(digest(target) == item['sha256'], 'Copy integrity failure; partial backup kept for review')
    write(destination / 'manifest.json', manifest)
    return report('backup', [check('integrity', 'pass', 'approved_files_copied')], manifest['source_version'],
                  files=len(manifest['files']))


def restore(source, destination):
    source = no_links(source)
    manifest = load(source / 'manifest.json')
    keys(manifest, {'schema_version', 'source_version', 'files'})
    require(manifest['schema_version'] == 1 and isinstance(manifest['files'], list) and 0 < len(manifest['files']) <= 1000)
    seen, verified, total = set(), [], 0
    for item in manifest['files']:
        keys(item, {'file', 'bytes', 'sha256'})
        require(isinstance(item['file'], str) and item['file'].casefold() not in seen, 'Duplicate manifest entry')
        seen.add(item['file'].casefold())
        path = selected(source / 'files', item['file'])
        total += path.stat().st_size
        require(total <= 100_000_000 and type(item['bytes']) is int and
                path.stat().st_size == item['bytes'] and digest(path) == item['sha256'], 'Restore integrity failure')
        verified.append((item, path))
    destination = no_links(inside_toolbox(destination))
    require(not destination.exists(), 'Restore destination must be new')
    require(not destination.resolve().is_relative_to(source.resolve()), 'Restore cannot be inside the backup')
    make_dirs(destination)
    for item, path in verified:
        target = destination / item['file']
        write_bytes_safely(target, path.read_bytes(), binary='image', require_unchanged=True)  # same rule as backup
        require(digest(target) == item['sha256'], 'Restore copy integrity failure')
    return report('restore', [check('integrity', 'pass', 'isolated_restore_matches')], manifest['source_version'])


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)
    s = sub.add_parser('preview'); s.add_argument('--input', required=True, type=Path); s.add_argument('--output', type=Path); s.add_argument('--scope', type=Path)
    s = sub.add_parser('backup'); s.add_argument('--input', required=True, type=Path)
    s.add_argument('--reviewed-manifest', required=True, type=Path); s.add_argument('--destination', required=True, type=Path)
    s.add_argument('--output', type=Path); s.add_argument('--scope', type=Path, required=True)
    s = sub.add_parser('restore'); s.add_argument('--backup', required=True, type=Path)
    s.add_argument('--destination', required=True, type=Path); s.add_argument('--output', type=Path)
    s.add_argument('--scope', type=Path, required=True)
    args = p.parse_args(argv)
    if args.command == 'preview':
        return emit(preview(load(args.input)), args.output, args.scope) and 0
    require_scope(args.scope)  # backup and restore always write
    if args.command == 'backup':
        return emit(backup(load(args.input), args.destination, load(args.reviewed_manifest)), args.output, args.scope)
    return emit(restore(args.backup, args.destination), args.output, args.scope)


if __name__ == '__main__':
    cli(main)
