import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../src/database/pool.js';
import { startServer, registerCustomer, createStaff, setLimits, fund, PIN, uid, balanceOf } from '../helpers.js';

let srv, staff, a, b;
const send = (from, to, amount, over = {}, key = uid()) => from.client.post('/api/v1/transfers/internal',
  { sourceAccountId: from.account.id, recipientIdentifier: to.account.public_identifier, amount, pin: PIN, ...over }, { 'idempotency-key': key });
before(async () => {
  srv = await startServer(); await setLimits('NGN', '1000000', '5000000');
  staff = await createStaff(srv.base, ['accountant']);
  a = await registerCustomer(srv.base); b = await registerCustomer(srv.base);
  await fund(a.account.id, '1000.00', staff.id);
});
after(() => srv.close());

test('internal transfer debits sender and credits recipient atomically with notifications, history and receipt', async () => {
  const lookup = await a.client.post('/api/v1/transfers/internal/lookup', { identifier: b.account.public_identifier });
  assert.equal(lookup.body.name, 'A** O*****'); assert.equal(lookup.body.currency, 'NGN');
  const r = await send(a, b, '250.75', { note: 'Rent' });
  assert.equal(r.status, 201); assert.equal(r.body.transaction.status, 'completed');
  assert.equal((await balanceOf(a.client, a.account.id)).available_balance, '749.25');
  assert.equal((await balanceOf(b.client, b.account.id)).available_balance, '250.75');
  const hist = await a.client.get(`/api/v1/accounts/${a.account.id}/transactions`);
  assert.equal(hist.body.transactions[0].direction, 'debit'); assert.equal(hist.body.transactions[0].amount, '250.75');
  const hb = await b.client.get(`/api/v1/accounts/${b.account.id}/transactions`);
  assert.equal(hb.body.transactions[0].direction, 'credit');
  const rc = await b.client.get(`/api/v1/transactions/${r.body.transaction.reference}/receipt`);
  assert.equal(rc.body.receipt.issuer, 'ZenvoBank'); assert.equal(rc.body.receipt.direction, 'credit');
  assert.match(rc.body.receipt.counterparty.name, /\*/, 'counterparty is masked'); assert.match(rc.body.receipt.counterparty.account, /\*\*\*\*/);
  assert.match(rc.body.receipt.notice, /TEST/);
  const html = await b.client.get(`/api/v1/transactions/${r.body.transaction.reference}/receipt?format=html`);
  assert.match(html.body, /ZenvoBank/);
  assert.equal((await a.client.get('/api/v1/notifications')).body.notifications[0].type, 'transfer');
  assert.equal((await b.client.get('/api/v1/notifications')).body.notifications.some(n => n.title === 'Money received'), true);
});

test('transfer guards: PIN, funds, validation, same account, cross-currency, missing key', async () => {
  assert.equal((await send(a, b, '1.00', { pin: '000001' })).body.error.code, 'invalid_pin');
  assert.equal((await send(a, b, '99999.00')).body.error.code, 'insufficient_funds');
  assert.equal((await send(a, b, '0')).status, 422);
  assert.equal((await send(a, b, '1.005')).body.error.code, 'amount_precision');
  assert.equal((await send(a, a, '1.00')).body.error.code, 'same_account');
  assert.equal((await send(a, { account: { public_identifier: 'ZB0000000000' } }, '1.00')).status, 404);
  const usd = await registerCustomer(srv.base, { country: 'US' });
  assert.equal((await send(a, usd, '1.00')).body.error.code, 'cross_currency_unsupported');
  const nokey = await a.client.post('/api/v1/transfers/internal', { sourceAccountId: a.account.id, recipientIdentifier: b.account.public_identifier, amount: '1.00', pin: PIN });
  assert.equal(nokey.body.error.code, 'idempotency_key_required');
  const nopin = await registerCustomer(srv.base, { pin: false });
  assert.equal((await send(nopin, a, '1.00', { pin: PIN })).body.error.code, 'pin_not_set');
  assert.equal((await balanceOf(a.client, a.account.id)).ledger_balance, '749.25', 'failed attempts moved nothing');
});

test('restricted or unverified accounts cannot send or receive', async () => {
  const unverified = await registerCustomer(srv.base, { verify: false });
  assert.equal((await send(unverified, b, '1.00')).body.error.code, 'account_not_active');
  assert.equal((await send(a, unverified, '1.00')).body.error.code, 'recipient_not_active');
  const ops = await createStaff(srv.base, ['operations_admin']);
  const r = await ops.client.post(`/api/v1/admin/accounts/${b.account.id}/status`, { status: 'restricted', reason: 'Fraud review in progress' });
  assert.equal(r.status, 200);
  assert.equal((await send(a, b, '1.00')).body.error.code, 'recipient_not_active');
  assert.equal((await send(b, a, '1.00')).body.error.code, 'account_not_active');
  await ops.client.post(`/api/v1/admin/accounts/${b.account.id}/status`, { status: 'active', reason: 'Review cleared by compliance' });
  assert.equal((await send(a, b, '1.00')).status, 201);
  assert.ok((await query(`SELECT 1 FROM audit_logs WHERE action = 'account.restricted' AND entity_id = $1`, [b.account.id])).rowCount === 1);
});

test('invariant 10: balances are reported at the currency precision (2 decimals for NGN)', async () => {
  const bal = await balanceOf(a.client, a.account.id);
  assert.match(bal.ledger_balance, /^\d+\.\d{2}$/);
});
