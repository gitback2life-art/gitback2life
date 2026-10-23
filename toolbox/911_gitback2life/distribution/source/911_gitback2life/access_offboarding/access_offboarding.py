"""access_offboarding: who (by role) can get into which of the organization's systems, and a safe checklist
for when someone leaves.

Uses the gitback2life core (same safety rules as org_registers): roles only, never names, passwords or
contact details; history is kept on every update; offline. The report flags owners/admins without two-step
login, access nobody needs any more, overdue reviews, and the lockout risk of a system with only one admin.

  python access_offboarding.py template                                print an empty register with examples
  python access_offboarding.py report --register FILE --as-of YYYY-MM-DD [--output FILE]
  python access_offboarding.py offboard --register FILE --role ROLE    checklist for one departing role
  python access_offboarding.py update --register FILE --record RECORD.json   (validates only: writing is disabled until
                                                                             approval enforcement exists, TOOLKIT_RULES 1e)
"""
import argparse
import copy
import datetime as dt
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True  # no __pycache__ files in the toolkit
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '_shared'))
from gb2l_core import check, cli, emit, identifier, keys, label, load, now, refuse_unapproved_update, report, require

FIELDS = {'id', 'system', 'role', 'access_level', 'mfa_enabled', 'still_needed', 'state', 'last_reviewed', 'evidence', 'status'}
LEVELS = {'owner', 'admin', 'editor', 'viewer', 'billing'}
MANAGERS = {'owner', 'admin'}
STATES = {'active', 'pending_removal', 'removed'}
REVIEW_DAYS = 180

TEMPLATE = {'schema_version': 1, 'history': [], 'records': [
    {'id': 'domain_board_secretary', 'system': 'domain_main', 'role': 'board_secretary', 'access_level': 'owner',
     'mfa_enabled': True, 'still_needed': True, 'state': 'active', 'last_reviewed': None, 'evidence': None, 'status': 'unresolved'},
    {'id': 'domain_web_volunteer', 'system': 'domain_main', 'role': 'web_volunteer', 'access_level': 'admin',
     'mfa_enabled': None, 'still_needed': True, 'state': 'active', 'last_reviewed': None, 'evidence': None, 'status': 'unresolved'},
]}


def _date(v):
    return dt.date.fromisoformat(v) if v else None


def validate(data):
    keys(data, {'schema_version', 'records', 'history'})
    require(data['schema_version'] == 1 and isinstance(data['records'], list) and isinstance(data['history'], list))
    seen = set()
    for r in data['records']:
        keys(r, FIELDS)
        identifier(r['id']); require(r['id'] not in seen, f'duplicate id {r["id"]}'); seen.add(r['id'])
        label(r['system']); label(r['role'])
        require(r['access_level'] in LEVELS, f'access_level must be one of {sorted(LEVELS)}')
        require(r['state'] in STATES, f'state must be one of {sorted(STATES)}')
        require(r['status'] in {'verified', 'unresolved', 'not_applicable'})
        for k in ('mfa_enabled', 'still_needed'):
            require(r[k] is None or type(r[k]) is bool, f'{k} must be true, false or null')
        _date(r['last_reviewed'])
        if r['evidence'] is not None:
            label(r['evidence'], 500)


def access_report(data, as_of):
    validate(data)
    as_of = dt.date.fromisoformat(as_of)
    out, managers = [], {}
    for r in data['records']:
        if r['state'] == 'removed':
            continue
        rid = r['id']
        if r['access_level'] in MANAGERS and r['state'] == 'active':
            managers.setdefault(r['system'], []).append(r['role'])
            mfa = r['mfa_enabled']
            out.append(check(f'{rid}__mfa', 'pass' if mfa is True else ('fail' if mfa is False else 'unresolved'), 'manager_two_step_login'))
        if r['still_needed'] is False and r['state'] == 'active':
            out.append(check(f'{rid}__remove', 'fail', 'access_no_longer_needed'))
        if r['state'] == 'pending_removal':
            out.append(check(f'{rid}__remove', 'unresolved', 'removal_pending'))
        reviewed = _date(r['last_reviewed'])
        if reviewed is None or (as_of - reviewed).days > REVIEW_DAYS:
            out.append(check(f'{rid}__review', 'unresolved', 'access_review_due'))
    systems = {r['system'] for r in data['records'] if r['state'] != 'removed'}
    for system in sorted(systems):
        n = len(managers.get(system, []))
        sid = identifier(system.replace(' ', '_')[:70]) + '__managers'
        out.append(check(sid, 'fail' if n == 0 else ('unresolved' if n == 1 else 'pass'),
                         'nobody_can_manage_it' if n == 0 else ('single_admin_lockout_risk' if n == 1 else 'two_or_more_admins')))
    return report('access', out, 'access-register-v1', 'metadata_register')


def offboard_checklist(data, role):
    validate(data)
    label(role)
    mine = [r for r in data['records'] if r['role'] == role and r['state'] != 'removed']
    require(mine, f'no current access recorded for role "{role}"')
    active_managers = {}
    for r in data['records']:
        if r['access_level'] in MANAGERS and r['state'] == 'active':
            active_managers.setdefault(r['system'], set()).add(r['role'])
    affected_systems = sorted({r['system'] for r in mine})
    # Assess each affected system AFTER removing every access record for the
    # departing role, not only records where this role currently manages it.
    # If a system already has no manager, that must never be described as safe.
    no_other_manager = [system for system in affected_systems
                        if not (active_managers.get(system, set()) - {role})]
    lines = [f'Offboarding checklist for role "{role}" (do these in order):', '']
    if no_other_manager:
        lines.append('1. FIRST confirm or establish another active owner/admin for:')
        lines += [f'   [ ] {system}: verify an independent owner/admin can log in' for system in no_other_manager]
        lines.append('   Some systems may ALREADY have no active manager recorded. Do not assume access is safe to remove.')
        lines.append('   Do not remove this role until an independent owner/admin is confirmed on each listed system.')
    else:
        lines.append('1. Verify an independent active owner/admin can log in on each affected system before removal.')
    lines += ['', '2. Remove this role\'s access:']
    lines += [f'   [ ] {r["system"]} ({r["access_level"]})' for r in sorted(mine, key=lambda r: r['access_level'] not in MANAGERS)]
    lines += ['', '3. Afterwards:',
              '   [ ] Change any shared passwords this role knew (never record them here).',
              '   [ ] Make sure recovery email/phone on each account is a role mailbox the organization controls, not this person\'s.',
              '   [ ] Update this register: set state to "removed" for each line above (history is kept).',
              '   [ ] Run the report again and confirm no system has fewer than two admins.']
    return '\n'.join(lines)


def register_update(data, record):
    result = copy.deepcopy(data)
    old = next((r for r in result['records'] if r['id'] == record.get('id')), None)
    result['history'].append({'at': now(), 'previous': old, 'replacement': record})
    result['records'] = [r for r in result['records'] if r['id'] != record.get('id')] + [record]
    validate(result)
    return result


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('template')
    r = sub.add_parser('report'); r.add_argument('--register', required=True, type=Path); r.add_argument('--as-of', required=True)
    r.add_argument('--output', type=Path); r.add_argument('--scope', type=Path)
    o = sub.add_parser('offboard'); o.add_argument('--register', required=True, type=Path); o.add_argument('--role', required=True)
    u = sub.add_parser('update'); u.add_argument('--register', required=True, type=Path); u.add_argument('--record', required=True, type=Path)
    args = p.parse_args(argv)
    if args.command == 'template':
        print(json.dumps(TEMPLATE, indent=2))
        return 0
    if args.command == 'offboard':
        print(offboard_checklist(load(args.register), args.role))
        return 0
    if args.command == 'update':
        # V7-01: validates the change, then refuses to write (no approval enforcement exists yet; TOOLKIT_RULES 1e).
        refuse_unapproved_update('access_offboarding', args.register, register_update(load(args.register), load(args.record)))
    return emit(access_report(load(args.register), args.as_of), args.output, args.scope)


if __name__ == '__main__':
    cli(main)
