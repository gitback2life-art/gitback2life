"""org_registers: keep track of the accounts and services a small organization depends on, and the personal data it holds.

Adapted from the gitback2life security suite metadata registers. Two register kinds:

  service  domain registrar, DNS, web host, email, website builder, donation/forms platforms, social accounts.
           The report flags lapsed or soon-to-lapse renewals (a common cause of hijacked or "redirecting"
           rescue websites), missing two-step login, and unreviewed recovery contacts.
  data     what personal data is held (adopters, donors, volunteers), where, for how long, and why.

Metadata only: record role names (e.g. "board_treasurer"), never passwords, codes or personal details.

  python org_registers.py template --kind service|data            print an empty register with one example
  python org_registers.py report --kind K --register FILE --as-of YYYY-MM-DD [--output FILE]
  python org_registers.py update --kind K --register FILE --record RECORD.json   (validates only: writing is disabled
                                                                                 until approval enforcement exists, TOOLKIT_RULES 1e)
"""
import argparse
import copy
import datetime as dt
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True  # no __pycache__ files in the toolkit
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '_shared'))
from gb2l_core import check, cli, emit, identifier, keys, label, load, now, refuse_unapproved_update, report, require, timestamp

SCHEMAS = {
    'service': {'id', 'service', 'provider', 'domain_or_account', 'account_owner_role', 'renews_on', 'auto_renew',
                'mfa_enabled', 'recovery_contact_reviewed', 'review_date', 'evidence', 'status'},
    'data': {'id', 'category', 'purpose', 'location', 'provider', 'owner', 'persistence',
             'retention_days', 'oldest_record_at', 'review_date', 'legal_hold', 'evidence', 'status'},
}
SERVICES = {'domain_registrar', 'dns', 'web_host', 'email', 'website_builder', 'donation_platform', 'forms',
            'social_media', 'code_hosting', 'other'}
RENEWAL_WARN_DAYS = 60
RENEWAL_FAIL_DAYS = 30

TEMPLATES = {
    'service': {'id': 'domain_main', 'service': 'domain_registrar', 'provider': 'Example Registrar',
                'domain_or_account': 'example-rescue.org', 'account_owner_role': 'board_secretary',
                'renews_on': '2027-03-01', 'auto_renew': True, 'mfa_enabled': None, 'recovery_contact_reviewed': None,
                'review_date': None, 'evidence': None, 'status': 'unresolved'},
    'data': {'id': 'adoption_applications', 'category': 'adopter_contact_details', 'purpose': 'process_adoptions',
             'location': 'forms_platform', 'provider': 'Example Forms', 'owner': 'adoption_coordinator',
             'persistence': 'unknown', 'retention_days': None, 'oldest_record_at': None, 'review_date': None,
             'legal_hold': False, 'evidence': None, 'status': 'unresolved'},
}


def _date(value):
    return dt.date.fromisoformat(value) if value else None


def validate_register(kind, data):
    require(kind in SCHEMAS, f'kind must be one of {sorted(SCHEMAS)}')
    keys(data, {'schema_version', 'records', 'history'})
    require(data['schema_version'] == 1 and isinstance(data['records'], list) and isinstance(data['history'], list))
    seen = set()
    for record in data['records']:
        keys(record, SCHEMAS[kind])
        identifier(record['id']); require(record['id'] not in seen, f'duplicate id {record["id"]}'); seen.add(record['id'])
        require(record['status'] in {'verified', 'unresolved', 'not_applicable'})
        for value in record.values():
            if value is None or type(value) in (bool, int):
                continue
            if isinstance(value, list):
                require(len(value) <= 100 and all(label(x) for x in value))
            else:
                label(value, 500)
        _date(record['review_date'])
        if kind == 'service':
            require(record['service'] in SERVICES, f'service must be one of {sorted(SERVICES)}')
            _date(record['renews_on'])
            for k in ('auto_renew', 'mfa_enabled', 'recovery_contact_reviewed'):
                require(record[k] is None or type(record[k]) is bool, f'{k} must be true, false or null')
        if kind == 'data':
            require(record['persistence'] in {'intended_none', 'confirmed_retained', 'unknown'})
            require(record['retention_days'] is None or (type(record['retention_days']) is int and record['retention_days'] >= 0))
            require(type(record['legal_hold']) is bool)
            if record['oldest_record_at']:
                timestamp(record['oldest_record_at'])
        if record['status'] == 'verified':
            require(record['evidence'] and record['review_date'], 'Verified records need evidence and a review date')
        if record['status'] == 'not_applicable':
            require(record['evidence'], 'An exclusion needs evidence')


def service_checks(r, as_of):
    out = []
    renews = _date(r['renews_on'])
    if renews is None:
        out.append(check(f'{r["id"]}__renewal', 'unresolved', 'renewal_date_unknown'))
    else:
        days = (renews - as_of).days
        if days < 0:
            out.append(check(f'{r["id"]}__renewal', 'fail', 'lapsed', r['renews_on']))
        elif days <= RENEWAL_FAIL_DAYS and r['auto_renew'] is not True:
            out.append(check(f'{r["id"]}__renewal', 'fail', 'renews_within_30_days_without_auto_renew', r['renews_on']))
        elif days <= RENEWAL_WARN_DAYS:
            out.append(check(f'{r["id"]}__renewal', 'unresolved', 'renewal_due_soon_confirm_payment_method', r['renews_on']))
        else:
            out.append(check(f'{r["id"]}__renewal', 'pass', 'renewal_not_imminent', r['renews_on']))
    mfa = r['mfa_enabled']
    out.append(check(f'{r["id"]}__mfa', 'pass' if mfa is True else ('fail' if mfa is False else 'unresolved'), 'two_step_login'))
    rec = r['recovery_contact_reviewed']
    out.append(check(f'{r["id"]}__recovery', 'pass' if rec is True else 'unresolved', 'recovery_contact_review'))
    return out


def data_check(r, as_of):
    state = 'unresolved' if r['status'] == 'unresolved' else ('not_applicable' if r['status'] == 'not_applicable' else 'pass')
    if state == 'pass' and r['persistence'] == 'confirmed_retained':
        if r['retention_days'] is None or r['oldest_record_at'] is None:
            state = 'unresolved'
        elif (as_of - timestamp(r['oldest_record_at']).date()).days > r['retention_days']:
            state = 'fail'
    return check(r['id'], state, 'record_review', r['evidence'])


def register_report(kind, data, as_of):
    validate_register(kind, data)
    as_of = dt.date.fromisoformat(as_of)
    out = []
    for r in data['records']:
        overdue = r['review_date'] is None or _date(r['review_date']) < as_of
        if r['status'] == 'not_applicable':
            out.append(check(r['id'], 'not_applicable', 'supported_exclusion', r['evidence']))
            continue
        out.extend(service_checks(r, as_of) if kind == 'service' else [data_check(r, as_of)])
        if overdue:
            out.append(check(f'{r["id"]}__review', 'unresolved', 'review_due'))
    return report(kind, out, 'register-v1', 'metadata_register')


def register_update(kind, data, record):
    result = copy.deepcopy(data)
    old = next((r for r in result['records'] if r['id'] == record.get('id')), None)
    result['history'].append({'at': now(), 'previous': old, 'replacement': record})
    result['records'] = [r for r in result['records'] if r['id'] != record.get('id')] + [record]
    validate_register(kind, result)
    return result


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)
    t = sub.add_parser('template'); t.add_argument('--kind', required=True, choices=sorted(SCHEMAS))
    r = sub.add_parser('report'); r.add_argument('--kind', required=True, choices=sorted(SCHEMAS))
    r.add_argument('--register', required=True, type=Path); r.add_argument('--as-of', required=True)
    r.add_argument('--output', type=Path); r.add_argument('--scope', type=Path)
    u = sub.add_parser('update'); u.add_argument('--kind', required=True, choices=sorted(SCHEMAS))
    u.add_argument('--register', required=True, type=Path); u.add_argument('--record', required=True, type=Path)
    args = p.parse_args(argv)
    if args.command == 'template':
        print(json.dumps({'schema_version': 1, 'records': [TEMPLATES[args.kind]], 'history': []}, indent=2))
        return 0
    if args.command == 'update':
        # V7-01: validates the change, then refuses to write (no approval enforcement exists yet; TOOLKIT_RULES 1e).
        refuse_unapproved_update('org_registers', args.register, register_update(args.kind, load(args.register), load(args.record)))
    return emit(register_report(args.kind, load(args.register), args.as_of), args.output, args.scope)


if __name__ == '__main__':
    cli(main)
