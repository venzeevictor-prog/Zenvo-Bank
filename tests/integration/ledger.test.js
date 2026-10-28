import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, query, withTx } from '../../src/database/pool.js';
import { startServer, registerCustomer, createStaff, setLimits, fund, PIN, uid, balanceOf } from '../helpers.js';
import {
  createFinancialTransaction, ensureSystemAccount, getBalances, placeHold, postJournal, releaseHold, reverseTransaction,
} from '../../src/modules/ledger/ledger.service.js';

let srv, staff, a, b;
before(async () => {
  srv = await startServer();
  await setLimits('NGN', '1000000', '5000000');
  staff = await createStaff(srv.base, ['accountant']);
  a = await registerCustomer(srv.base);
  b = await registerCustomer(srv.base);
  await fund(a.account.id, '100.00', staff.id);
});
after(() => srv.close());

const ledgerOf = async (acctId) => (await query('SELECT ledger_account_id FROM customer_accounts WHERE id = $1', [acctId])).rows[0].ledger_account_id;

test('invariant 1: unbalanced entries are rejected by the service and by the database', async () => {
  const la = await ledgerOf(a.account.id), lb = await ledgerOf(b.account.id);
  await assert.rejects(withTx(async (c) => {
    const tx = await createFinancialTransaction(c, { type: 'internal_transfer', currency: 'NGN', amount: '5.00', description: 't' });
    await postJournal(c, { transactionId: tx.id, description: 'x', currency: 'NGN', lines: [
      { ledgerAccountId: la, direction: 'D', amount: '5.00' }, { ledgerAccountId: lb, direction: 'C', amount: '4.00' }] });
  }), /not balanced/);
  // Bypass the service entirely: raw SQL must still be stopped by the deferred constraint trigger at COMMIT.
  await assert.rejects(withTx(async (c) => {
    const tx = await createFinancialTransaction(c, { type: 'internal_transfer', currency: 'NGN', amount: '5.00', description: 't' });
    const je = (await c.query(`INSERT INTO journal_entries (financial_transaction_id, description, currency) VALUES ($1,'raw','NGN') RETURNING id`, [tx.id])).rows[0].id;
    await c.query(`INSERT INTO ledger_postings (journal_entry_id, ledger_account_id, direction, amount, currency) VALUES ($1,$2,'C',50,'NGN'),($1,$3,'D',10,'NGN')`, [je, la, lb]);
  }), /not balanced/);
});

test('invariant 6: posted ledger rows and transactions cannot be edited or deleted', async () => {
  await assert.rejects(query(`UPDATE ledger_postings SET amount = 1 WHERE id = (SELECT min(id) FROM ledger_postings)`), /immutable/);
  await assert.rejects(query(`DELETE FROM ledger_postings WHERE id = (SELECT min(id) FROM ledger_postings)`), /immutable/);
  await assert.rejects(query(`UPDATE journal_entries SET description = 'x'`), /immutable/);
  await assert.rejects(query(`TRUNCATE ledger_postings CASCADE`), /immutable/);
  await assert.rejects(query(`DELETE FROM financial_transactions`), /cannot be deleted/);
  await assert.rejects(query(`UPDATE financial_transactions SET amount = 1`), /immutable/);
  await assert.rejects(query(`UPDATE audit_logs SET action = 'x'`), /immutable/);
});

test('invariant 10: currency and precision are enforced at the database level', async () => {
  const la = await ledgerOf(a.account.id);
  await assert.rejects(withTx(async (c) => {
    const tx = await createFinancialTransaction(c, { type: 'internal_transfer', currency: 'USD', amount: '1.00', description: 't' });
    const usd = await ensureSystemAccount(c, 'SETTLEMENT', 'USD');
    // Posting a USD entry against an NGN ledger account must fail
    await postJournal(c, { transactionId: tx.id, description: 'x', currency: 'USD', lines: [
      { ledgerAccountId: usd, direction: 'D', amount: '1.00' }, { ledgerAccountId: la, direction: 'C', amount: '1.00' }] });
  }), /currency mismatch/);
  await assert.rejects(withTx(async (c) => {
    const tx = await createFinancialTransaction(c, { type: 'internal_transfer', currency: 'JPY', amount: '1', description: 't' });
    const s = await ensureSystemAccount(c, 'SETTLEMENT', 'JPY'), r = await ensureSystemAccount(c, 'REFUNDS', 'JPY');
    await postJournal(c, { transactionId: tx.id, description: 'x', currency: 'JPY', lines: [
      { ledgerAccountId: s, direction: 'D', amount: '10.5' }, { ledgerAccountId: r, direction: 'C', amount: '10.5' }] });
  }), /decimal places/);
});

test('balances come from the ledger; holds reduce available funds', async () => {
  const c = await registerCustomer(srv.base);
  await fund(c.account.id, '250.00', staff.id);
  let bal = await balanceOf(c.client, c.account.id);
  assert.deepEqual([bal.ledger_balance, bal.available_balance, bal.pending_holds], ['250.00', '250.00', '0.00']);
  const hold = await withTx(cl => placeHold(cl, { customerAccountId: c.account.id, amount: '200.00', reason: 'test hold' }));
  bal = await balanceOf(c.client, c.account.id);
  assert.deepEqual([bal.ledger_balance, bal.available_balance, bal.pending_holds], ['250.00', '50.00', '200.00']);
  await assert.rejects(withTx(cl => placeHold(cl, { customerAccountId: c.account.id, amount: '60.00', reason: 'too much' })), /Insufficient/);
  // transfer cannot spend held funds
  const r = await c.client.post('/api/v1/transfers/internal', { sourceAccountId: c.account.id, recipientIdentifier: b.account.public_identifier, amount: '60.00', pin: PIN }, { 'idempotency-key': uid() });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'insufficient_funds');
  await withTx(cl => releaseHold(cl, hold.id));
  bal = await balanceOf(c.client, c.account.id);
  assert.equal(bal.available_balance, '250.00');
});

test('invariant 5: reversal posts compensating entries, keeps history, and cannot happen twice', async () => {
  const c = await registerCustomer(srv.base), d = await registerCustomer(srv.base);
  await fund(c.account.id, '80.00', staff.id);
  const t = await c.client.post('/api/v1/transfers/internal', { sourceAccountId: c.account.id, recipientIdentifier: d.account.public_identifier, amount: '30.00', pin: PIN }, { 'idempotency-key': uid() });
  assert.equal(t.status, 201);
  const orig = (await query('SELECT id FROM financial_transactions WHERE reference = $1', [t.body.transaction.reference])).rows[0];
  const before = (await query('SELECT count(*)::int n FROM ledger_postings')).rows[0].n;
  const rev = await withTx(cl => reverseTransaction(cl, { transactionId: orig.id, reason: 'test reversal', staffId: staff.id }));
  assert.equal(rev.type, 'reversal');
  assert.equal((await balanceOf(c.client, c.account.id)).ledger_balance, '80.00');
  assert.equal((await balanceOf(d.client, d.account.id)).ledger_balance, '0.00');
  assert.equal((await query('SELECT count(*)::int n FROM ledger_postings')).rows[0].n, before + 2, 'history is appended, not rewritten');
  assert.equal((await query('SELECT status FROM financial_transactions WHERE id = $1', [orig.id])).rows[0].status, 'reversed');
  await assert.rejects(withTx(cl => reverseTransaction(cl, { transactionId: orig.id, reason: 'again', staffId: staff.id })), /reversed/);
});

test('a reversal that would overdraw a customer is refused', async () => {
  const c = await registerCustomer(srv.base), d = await registerCustomer(srv.base);
  await fund(c.account.id, '50.00', staff.id);
  const t = await c.client.post('/api/v1/transfers/internal', { sourceAccountId: c.account.id, recipientIdentifier: d.account.public_identifier, amount: '50.00', pin: PIN }, { 'idempotency-key': uid() });
  // d spends the money onward, then the original is reversed -> d would go negative
  const e = await registerCustomer(srv.base);
  await d.client.post('/api/v1/transfers/internal', { sourceAccountId: d.account.id, recipientIdentifier: e.account.public_identifier, amount: '50.00', pin: PIN }, { 'idempotency-key': uid() });
  const orig = (await query('SELECT id FROM financial_transactions WHERE reference = $1', [t.body.transaction.reference])).rows[0];
  await assert.rejects(withTx(cl => reverseTransaction(cl, { transactionId: orig.id, reason: 'x', staffId: staff.id })), /overdraw/);
});

test('invariant 4: concurrent transfers cannot spend the same balance twice', async () => {
  const c = await registerCustomer(srv.base), d = await registerCustomer(srv.base);
  await fund(c.account.id, '100.00', staff.id);
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    c.client.post('/api/v1/transfers/internal', { sourceAccountId: c.account.id, recipientIdentifier: d.account.public_identifier, amount: '30.00', pin: PIN }, { 'idempotency-key': uid() })));
  const ok = results.filter(r => r.status === 201).length;
  assert.equal(ok, 3, `expected exactly 3 successes, got ${ok}: ${results.map(r => r.status)}`);
  assert.equal((await balanceOf(c.client, c.account.id)).ledger_balance, '10.00');
  assert.equal((await balanceOf(d.client, d.account.id)).ledger_balance, '90.00');
});

test('invariant 2: concurrent duplicate requests with one Idempotency-Key post once', async () => {
  const c = await registerCustomer(srv.base), d = await registerCustomer(srv.base);
  await fund(c.account.id, '100.00', staff.id);
  const key = uid();
  const body = { sourceAccountId: c.account.id, recipientIdentifier: d.account.public_identifier, amount: '10.00', pin: PIN };
  const rs = await Promise.all(Array.from({ length: 5 }, () => c.client.post('/api/v1/transfers/internal', body, { 'idempotency-key': key })));
  assert.ok(rs.every(r => [200, 201].includes(r.status)), JSON.stringify(rs.map(r => r.status)));
  assert.equal(new Set(rs.map(r => r.body.transaction.reference)).size, 1);
  assert.equal((await balanceOf(c.client, c.account.id)).ledger_balance, '90.00');
  const reuse = await c.client.post('/api/v1/transfers/internal', { ...body, amount: '11.00' }, { 'idempotency-key': key });
  assert.equal(reuse.status, 409); assert.equal(reuse.body.error.code, 'idempotency_key_reuse');
});

test('every journal entry in the database balances per currency (global invariant)', async () => {
  const bad = (await query(`SELECT journal_entry_id FROM ledger_postings GROUP BY journal_entry_id
     HAVING SUM(amount) FILTER (WHERE direction='D') IS DISTINCT FROM SUM(amount) FILTER (WHERE direction='C')`)).rows;
  assert.equal(bad.length, 0);
  const neg = (await query(`SELECT la.code FROM ledger_accounts la JOIN ledger_postings p ON p.ledger_account_id = la.id
     WHERE la.is_customer GROUP BY la.code HAVING SUM(CASE p.direction WHEN 'C' THEN p.amount ELSE -p.amount END) < 0`)).rows;
  assert.equal(neg.length, 0, 'no customer account is negative');
});
