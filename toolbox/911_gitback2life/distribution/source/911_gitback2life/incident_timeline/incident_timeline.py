"""incident_timeline: a UTC timeline and decision record for a real incident or a practice exercise.

Adapted from the gitback2life security suite incident tabletop runner, widened to the problems small
organizations actually hit. Every stage of the response needs a recorded decision; anything missing stays
"unresolved". A complete flag means someone recorded that decision, not that it was proved to work.

  python incident_timeline.py --input incident.json [--output FILE]

incident.json: {"id": "...", "scenario": "website_redirect", "mode": "real" | "exercise",
  "events": [{"at": "...Z", "stage": "recognize", "fact_status": "reported", "reference": "issue-1-oct-5-report"}],
  "decisions": {"contain": {"owner": "role", "reference": "...", "complete": false}, ...}}
See PLAYBOOK.md for what each stage means.
"""
import argparse
from pathlib import Path
import sys

sys.dont_write_bytecode = True  # no __pycache__ files in the toolkit
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '_shared'))
from gb2l_core import check, cli, emit, identifier, keys, label, load, report, require, timestamp

SCENARIOS = {'website_redirect', 'domain_expiry', 'account_takeover', 'data_exposure', 'content_logging',
             'service_outage', 'other'}
STAGES = ['recognize', 'contain', 'preserve', 'scope', 'notify_assessment', 'recover', 'follow_up']
FACT_STATUS = {'confirmed', 'reported', 'unknown', 'simulated'}


def incident(c):
    keys(c, {'id', 'scenario', 'mode', 'events', 'decisions'})
    identifier(c['id'])
    require(c['scenario'] in SCENARIOS, f'scenario must be one of {sorted(SCENARIOS)}')
    require(c['mode'] in {'real', 'exercise'}, 'mode must be real or exercise')
    require(isinstance(c['events'], list) and len(c['events']) <= 200)
    timeline = []
    for e in c['events']:
        keys(e, {'at', 'stage', 'fact_status', 'reference'})
        timestamp(e['at'])
        require(e['stage'] in STAGES, f'stage must be one of {STAGES}')
        require(e['fact_status'] in FACT_STATUS, f'fact_status must be one of {sorted(FACT_STATUS)}')
        require(c['mode'] == 'exercise' or e['fact_status'] != 'simulated', 'simulated facts are only allowed in exercises')
        label(e['reference'])
        timeline.append(e)
    decisions = c['decisions']
    keys(decisions, set(), set(STAGES))
    out = []
    for stage in STAGES:
        d = decisions.get(stage)
        if d is not None:
            keys(d, {'owner', 'reference', 'complete'})
            label(d['owner']); label(d['reference']); require(type(d['complete']) is bool)
        out.append(check(stage, 'pass' if d and d['complete'] else 'unresolved', 'recorded_decision'))
    unknown = sum(1 for e in timeline if e['fact_status'] in {'unknown', 'reported'})
    return report('incident_timeline', out, 'scenario-v2', 'incident_record' if c['mode'] == 'real' else 'synthetic_tabletop',
                  timeline=sorted(timeline, key=lambda e: timestamp(e['at'])), scenario=c['scenario'],
                  findings=[{'unverified_events': unknown}])


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--input', required=True, type=Path)
    p.add_argument('--output', type=Path)
    p.add_argument('--scope', type=Path, help='incident scope; required with --output')
    args = p.parse_args(argv)
    return emit(incident(load(args.input)), args.output, args.scope)


if __name__ == '__main__':
    cli(main)
