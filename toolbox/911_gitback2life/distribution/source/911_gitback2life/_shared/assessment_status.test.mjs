import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coverage, failureKind, failureRecord} from './assessment_status.mjs';
test('common reliability vocabulary across all approved workflows',()=>{
 assert.equal(coverage(['dns','rdap']).status,'verified');
 assert.equal(coverage(['rdap'],[{check:'dns'}]).status,'partial');
 assert.equal(coverage([],[{check:'dns'}]).status,'unverified');
 for (const code of ['EAI_AGAIN','ECONNREFUSED','ETIMEOUT'])
   assert.equal(failureKind({code}),'network_unavailable');
 assert.equal(failureKind({code:'SCOPE_BLOCKED'}),'permission_or_safety');
 assert.equal(failureKind({code:'POLITE_BUDGET'}),'request_limit');
 assert.equal(failureRecord('dns',{code:'EAI_AGAIN'}).status,'unverified');
});
