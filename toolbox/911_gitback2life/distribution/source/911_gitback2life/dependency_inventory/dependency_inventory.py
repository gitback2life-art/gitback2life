"""dependency_inventory: list the npm packages and licenses a website project depends on.

Adapted from the gitback2life security suite dependency report. Reads package.json and an npm lockfile
(v2/v3) under an explicit root. No network, no installs. Optional advisories are dated metadata you supply
from an official source; matching is exact-version only.

  python dependency_inventory.py --input config.json [--output FILE]

config.json: {"root": "...", "manifest": "package.json", "lockfile": "package-lock.json",
              "source_version": "commit-or-label",
              "advisories": {"observed_at": "...Z", "source": "...", "affected": [{"name","version","advisory_id"}]}}
"""
import argparse
from pathlib import Path
import sys

sys.dont_write_bytecode = True  # no __pycache__ files in the toolkit
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '_shared'))
from gb2l_core import check, cli, emit, keys, label, load, report, require, selected, timestamp


def dependencies(c):
    keys(c, {'root', 'manifest', 'lockfile', 'source_version'}, {'advisories'})
    manifest = load(selected(c['root'], c['manifest']))
    lock = load(selected(c['root'], c['lockfile']), limit=20_000_000)
    require(lock.get('lockfileVersion') in (2, 3), 'Supports npm lockfile version 2 or 3 only')
    direct = {**manifest.get('dependencies', {}), **manifest.get('devDependencies', {})}
    inventory = []
    for location, pkg in lock.get('packages', {}).items():
        if not location or not isinstance(pkg, dict):
            continue
        name = pkg.get('name') or location.split('node_modules/')[-1]
        label(name)
        version = pkg.get('version', 'unknown'); label(version)
        license_name = pkg.get('license', 'unknown')
        license_name = license_name if isinstance(license_name, str) and license_name else 'unknown'
        label(license_name)
        inventory.append(dict(name=name, locked_version=version, installed_version='unverified',
                              manifest_range=label(direct[name]) if name in direct else None,
                              dev=bool(pkg.get('dev')), license=license_name, obligations='manual_review'))
    advisories = c.get('advisories')
    findings = []
    if advisories is not None:
        keys(advisories, {'observed_at', 'source', 'affected'})
        timestamp(advisories['observed_at']); label(advisories['source'])
        for item in advisories['affected']:
            keys(item, {'name', 'version', 'advisory_id'})
            for v in item.values():
                label(v)
            if any(p['name'] == item['name'] and p['locked_version'] == item['version'] for p in inventory):
                findings.append(item)
    unknown_licenses = sorted({p['name'] for p in inventory if p['license'] == 'unknown'})
    checks = [check('advisories', 'unresolved' if advisories is None else ('fail' if findings else 'unresolved'),
                    'coverage_requires_review'),
              check('license_obligations', 'unresolved', 'rights_review_required')]
    return report('dependencies', checks, c['source_version'], inventory=inventory, advisories=findings,
                  findings=[{'unknown_license': n} for n in unknown_licenses])


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--input', required=True, type=Path)
    p.add_argument('--output', type=Path)
    p.add_argument('--scope', type=Path, help='incident scope; required with --output')
    args = p.parse_args(argv)
    return emit(dependencies(load(args.input)), args.output, args.scope)


if __name__ == '__main__':
    cli(main)
