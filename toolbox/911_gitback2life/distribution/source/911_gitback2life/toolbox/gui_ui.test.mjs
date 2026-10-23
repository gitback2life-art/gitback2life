// Original thirteen groups plus the owner-approved Email Communications group must match the WinForms button labels.
// A UI change must not silently add tools or reroute a button to another action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TOOL_GROUPS } from './toolbox.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const ui = readFileSync(join(root, 'toolbox', 'ToolboxUI.ps1'), 'utf8');
const launcher = readFileSync(join(root, 'TOOLBOX.cmd'), 'utf8');
const psGroups = [...ui.matchAll(/^\s*@\{ Name='((?:''|[^'])+)'; Actions=@\((.*)\) \},?\s*$/gm)].map(m => ({
  name: m[1].replaceAll("''", "'"),
  actions: [...m[2].matchAll(/'((?:''|[^'])+)'/g)].map(x => x[1].replaceAll("''", "'")),
}));
test('mouse and numeric-key buttons match all fourteen owner-approved menu groups and actions', () => {
  assert.equal(TOOL_GROUPS.length, 14);
  assert.deepEqual(psGroups.map(g => g.name), TOOL_GROUPS.map(g => g.name));
  for (let i = 0; i < 14; i++) {
    assert.deepEqual(psGroups[i].actions, TOOL_GROUPS[i].actions.map(a => a.label), `tool ${i + 1}`);
    assert.ok(psGroups[i].actions.length >= 1 && psGroups[i].actions.length <= 9);
  }
});
test('buttons require validated numeric groups and launch only existing guided actions', () => {
  assert.match(ui, /--menu-action \{1\} \{2\}/);
  assert.match(ui, /\$group -gt 14/m);
  assert.match(ui, /Finish the open toolbox action before starting another/);
  assert.match(launcher, /if "%~1"=="" goto :SHOW_UI/);
  assert.match(launcher, /node\.exe "%ROOT%toolbox\\toolbox\.mjs" %\* 2>>/);
});
test('number keys and mouse share the same navigation', () => {
  assert.match(ui, /NumPad/);
  assert.match(ui, /Show-Actions \(9 \+ \$digit\)/);
  assert.match(ui, /Show-Actions \(\[int\]\$sender\.Tag\)/);
  assert.match(ui, /Start-Action \(\[int\]\$sender\.Tag\)/);
  assert.match(ui, /\$script:back\.Add_Click\(\{ Show-Home \}\)/);
});
