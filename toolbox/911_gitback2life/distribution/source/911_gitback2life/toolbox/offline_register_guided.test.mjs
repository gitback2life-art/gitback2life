// Human-guided metadata-entry regressions: pure local prompts, never authority writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordValue, promptRecord } from './register_editor.mjs';

test('guided date entry rejects impossible days before a record is prepared', () => {
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-03-00', 'not-a-date']) {
    assert.throws(() => parseRecordValue('access','last_reviewed',date,null), /real calendar date/);
  }
  assert.equal(parseRecordValue('access','last_reviewed','2024-02-29',null), '2024-02-29');
  assert.equal(parseRecordValue('access','last_reviewed','-',null),null);
  assert.throws(() => parseRecordValue('data','oldest_record_at','2026-10-20Tnot-a-timeZ',null), /ISO timestamp/);
});
test('guided register prompt corrects one bad field without losing other input', async () => {
  // Field order is the original schema; invalid choice/date are repeated in
  // place. A canceled prompt must not prepare or submit a change request.
  const inputs = ['a1', '', 'sample_site', 'role_1', 'not-valid', '4', '', 'yes', '1', '2026-02-30', '2024-02-29', '', ''];
  let prompts = 0;
  const ask = async () => { prompts++; if (!inputs.length) throw new Error('unexpected extra prompt'); return inputs.shift(); };
  const record = await promptRecord('access', ask);
  assert.equal(prompts, 13);
  assert.equal(record.id,'a1');
  assert.equal(record.system,'sample_site');
  assert.equal(record.role,'role_1');
  assert.equal(record.access_level,'viewer');
  assert.equal(record.still_needed,true);
  assert.equal(record.last_reviewed,'2024-02-29');
});
test('empty required new identifiers and fields are reprompted rather than accepted', async () => {
  const inputs = ['', 'a2', '', 'website', '', 'admin', '', '', '', '', '', '', ''];
  let prompts = 0;
  const record = await promptRecord('access', async () => { prompts++; if (!inputs.length) throw new Error('unexpected extra prompt'); return inputs.shift(); });
  assert.equal(record.id, 'a2');
  assert.equal(prompts, 13);
});

test('existing offline account-recovery guides are listed and selected without a network operation', async () => {
  const tb = await import('./toolbox.mjs');
  const listed = tb.listRecoveryProviders();
  assert.ok(listed.length >= 3);
  assert.deepEqual(tb.selectRecoveryProvider(listed,'1'), listed[0].key);
  assert.deepEqual(tb.selectRecoveryProvider(listed,'#2'), listed[1].key);
  assert.deepEqual(tb.selectRecoveryProvider(listed,'0'),'');
  assert.deepEqual(tb.selectRecoveryProvider(listed,''),'');
  assert.deepEqual(tb.selectRecoveryProvider(listed,listed[0].key),listed[0].key);
  assert.throws(() => tb.selectRecoveryProvider(listed,String(listed.length + 1)),/displayed/);
  assert.throws(() => tb.selectRecoveryProvider(listed,'fake_provider'),/existing bundled/);
  assert.match(tb.recoveryGuide(listed[0].key), /official help site/);
});
