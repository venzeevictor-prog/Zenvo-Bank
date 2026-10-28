import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../src/database/pool.js';
import { startServer, registerCustomer, createStaff, setLimits, uid, balanceOf } from '../helpers.js';

let srv, accountant, approver1, approver2, support, customer;
const adjBody = (over = {}) => ({
  customerAccountId: customer.account.id, direction: 'credit', amount: '500.00', reasonCode: 'CORRECTION_CREDIT',
  explanation: 'Correcting a misposted settlement entry', internalReference: 'INT-1001', ...over });
const create = (staff, body, key = uid()) => staff.client.post('/api/v1/admin/adjustments', body, { 'idempotency-key': key });

before(async () => {
  srv = await startServer();
  await setLimits('NGN', '1000', '10000');           // auto-post <=1,000; single approver <=10,000; two approvers above
  accountant = await createStaff(srv.base, ['accountant']);
  approver1 = await createStaff(srv.base, ['accounting_approver']);
  approver2 = await createStaff(srv.base, ['accounting_approver']);
  support = await createStaff(srv.base, ['support_agent']);
  customer = await registerCustomer(srv.base);
});
after(() => srv.close());

test('small adjustment within the auto-post limit posts immediately, with ledger entries and an audit trail', async () => {
  const r = await create(accountant, adjBody({ amount: '500.00' }));
  assert.equal(r.status, 201); assert.equal(r.body.adjustment.status, 'posted'); assert.equal(r.body.adjustment.approvals_required, 0);
  assert.equal((await balanceOf(customer.client, customer.account.id)).ledger_balance, '500.00');
  const audit = (await query(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`, [r.body.adjustment.id])).rows.map(x => x.action);
  assert.deepEqual(audit, ['adjustment.requested', 'adjustment.posted']);
  const tx = (await query('SELECT * FROM financial_transactions WHERE id = $1', [r.body.adjustment.financial_transaction_id])).rows[0];
  assert.equal(tx.type, 'adjustment_credit'); assert.equal(tx.is_test, true, 'dev money is labelled as test money');
});

test('invariant 7: every posted adjustment has a counter-account (accounting source), a reason and an initiator', async () => {
  const rows = (await query(
    `SELECT a.reason_code, a.initiated_by, la.code
       FROM account_adjustments a JOIN journal_entries j ON j.financial_transaction_id = a.financial_transaction_id
       JOIN ledger_postings p ON p.journal_entry_id = j.id JOIN ledger_accounts la ON la.id = p.ledger_account_id
      WHERE a.status = 'posted' AND NOT la.is_customer`)).rows;
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.code.startsWith('SYS-') && r.reason_code && r.initiated_by));
});

test('mid-size adjustment needs one approver; initiator cannot self-approve (invariant 3)', async () => {
  const r = await create(accountant, adjBody({ amount: '5000.00' }));
  assert.equal(r.body.adjustment.status, 'pending_approval'); assert.equal(r.body.adjustment.approvals_required, 1);
  const id = r.body.adjustment.id;
  // an accountant who is also an approver still cannot approve their own request
  const hybrid = await createStaff(srv.base, ['accountant', 'accounting_approver']);
  const own = await create(hybrid, adjBody({ amount: '5000.00' }));
  const self = await hybrid.client.post(`/api/v1/admin/adjustments/${own.body.adjustment.id}/approve`, {});
  assert.equal(self.status, 403); assert.match(self.body.error.message, /own/);
  // the plain accountant lacks the approve permission entirely
  assert.equal((await accountant.client.post(`/api/v1/admin/adjustments/${id}/approve`, {})).status, 403);
  const ok = await approver1.client.post(`/api/v1/admin/adjustments/${id}/approve`, { comment: 'Checked against statement' });
  assert.equal(ok.status, 200); assert.equal(ok.body.adjustment.status, 'posted');
  assert.equal((await balanceOf(customer.client, customer.account.id)).ledger_balance, '5500.00');
  assert.equal((await approver1.client.post(`/api/v1/admin/adjustments/${id}/approve`, {})).status, 409, 'cannot approve twice / after posting');
});

test('large adjustment needs two distinct approvers', async () => {
  const r = await create(accountant, adjBody({ amount: '20000.00' }));
  assert.equal(r.body.adjustment.approvals_required, 2);
  const id = r.body.adjustment.id;
  const a1 = await approver1.client.post(`/api/v1/admin/adjustments/${id}/approve`, {});
  assert.equal(a1.body.adjustment.status, 'pending_approval');
  assert.equal((await approver1.client.post(`/api/v1/admin/adjustments/${id}/approve`, {})).status, 409, 'same approver cannot count twice');
  assert.equal((await balanceOf(customer.client, customer.account.id)).ledger_balance, '5500.00', 'nothing posted yet');
  const a2 = await approver2.client.post(`/api/v1/admin/adjustments/${id}/approve`, {});
  assert.equal(a2.body.adjustment.status, 'posted');
  assert.equal((await balanceOf(customer.client, customer.account.id)).ledger_balance, '25500.00');
  const detail = await accountant.client.get(`/api/v1/admin/adjustments/${id}`);
  assert.equal(detail.body.approvals.length, 2);
});

test('with no configured limits, every adjustment needs two approvers (safe default)', async () => {
  const kes = await registerCustomer(srv.base, { country: 'KE' });
  const r = await create(accountant, adjBody({ customerAccountId: kes.account.id, amount: '1.00' }));
  assert.equal(r.body.adjustment.status, 'pending_approval'); assert.equal(r.body.adjustment.approvals_required, 2);
});

test('rejection leaves balances untouched and records the reason', async () => {
  const before = (await balanceOf(customer.client, customer.account.id)).ledger_balance;
  const r = await create(accountant, adjBody({ amount: '4000.00' }));
  const rej = await approver1.client.post(`/api/v1/admin/adjustments/${r.body.adjustment.id}/reject`, { reason: 'No supporting evidence' });
  assert.equal(rej.body.adjustment.status, 'rejected');
  assert.equal((await balanceOf(customer.client, customer.account.id)).ledger_balance, before);
  assert.equal((await approver2.client.post(`/api/v1/admin/adjustments/${r.body.adjustment.id}/approve`, {})).status, 409);
});

test('debit adjustments cannot overdraw; they post when funds exist', async () => {
  const c = await registerCustomer(srv.base);
  await create(accountant, adjBody({ customerAccountId: c.account.id, amount: '300.00' }));
  const over = await create(accountant, adjBody({ customerAccountId: c.account.id, direction: 'debit', reasonCode: 'CORRECTION_DEBIT', amount: '300.01' }));
  assert.equal(over.status, 422); assert.equal(over.body.error.code, 'insufficient_funds');
  const ok = await create(accountant, adjBody({ customerAccountId: c.account.id, direction: 'debit', reasonCode: 'FEE_CHARGE', amount: '100.00' }));
  assert.equal(ok.body.adjustment.status, 'posted');
  assert.equal((await balanceOf(c.client, c.account.id)).ledger_balance, '200.00');
});

test('funding rules: provider/bank reference required for deposits; reason/direction must match; promo credits disabled', async () => {
  assert.equal((await create(accountant, adjBody({ reasonCode: 'DEPOSIT_CONFIRMED' }))).body.error.code, 'external_reference_required');
  assert.equal((await create(accountant, adjBody({ reasonCode: 'FEE_CHARGE' }))).body.error.code, 'reason_direction_mismatch');
  assert.equal((await create(accountant, adjBody({ reasonCode: 'NOPE_REASON' }))).body.error.code, 'invalid_reason');
  assert.equal((await create(accountant, adjBody({ reasonCode: 'PROMOTIONAL_CREDIT' }))).body.error.code, 'promo_disabled');
  const dep = await create(accountant, adjBody({ reasonCode: 'DEPOSIT_CONFIRMED', externalReference: 'PROV-REF-7781', amount: '100.00' }));
  assert.equal(dep.body.adjustment.status, 'posted');
  assert.equal(dep.body.adjustment.external_reference_verified, false, 'manual attestation is NOT provider verification');
});

test('validation: precision, explanation length, missing idempotency key, closed/unknown accounts', async () => {
  assert.equal((await create(accountant, adjBody({ amount: '10.001' }))).body.error.code, 'amount_precision');
  assert.equal((await create(accountant, adjBody({ amount: '-5' }))).status, 422);
  assert.equal((await create(accountant, adjBody({ explanation: 'short' }))).status, 422);
  assert.equal((await accountant.client.post('/api/v1/admin/adjustments', adjBody())).body.error.code, 'idempotency_key_required');
  assert.equal((await create(accountant, adjBody({ customerAccountId: uid() }))).status, 404);
  const unverified = await registerCustomer(srv.base, { verify: false, pin: false });
  assert.equal((await create(accountant, adjBody({ customerAccountId: unverified.account.id }))).body.error.code, 'account_not_active');
});

test('adjustment requests are idempotent per staff member', async () => {
  const key = uid();
  const a = await create(accountant, adjBody({ amount: '5000.00' }), key);
  const b = await create(accountant, adjBody({ amount: '5000.00' }), key);
  assert.equal(a.body.adjustment.id, b.body.adjustment.id); assert.equal(b.body.replayed, true);
  assert.equal((await create(accountant, adjBody({ amount: '5001.00' }), key)).status, 409);
});

test('concurrent approvals cannot double-post an adjustment', async () => {
  const c = await registerCustomer(srv.base);
  const r = await create(accountant, adjBody({ customerAccountId: c.account.id, amount: '5000.00' }));
  const id = r.body.adjustment.id;
  const approver3 = await createStaff(srv.base, ['accounting_approver']);
  const rs = await Promise.all([approver1, approver2, approver3].map(a => a.client.post(`/api/v1/admin/adjustments/${id}/approve`, {})));
  assert.equal(rs.filter(x => x.status === 200).length, 1);
  assert.equal((await balanceOf(c.client, c.account.id)).ledger_balance, '5000.00');
});

test('integrity report is clean after all of the above', async () => {
  const r = await accountant.client.get('/api/v1/admin/reconciliation/ledger-integrity');
  assert.equal(r.status, 200); assert.equal(r.body.ok, true, JSON.stringify(r.body));
});
