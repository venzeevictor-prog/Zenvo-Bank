import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../src/database/pool.js';
import { Client, startServer, registerCustomer, createStaff, setLimits, fund, PIN, uid } from '../helpers.js';

let srv, alice, bob, accountant, support, auditor, ref;
before(async () => {
  srv = await startServer();
  await setLimits('NGN', '1000000', '5000000');
  accountant = await createStaff(srv.base, ['accountant']);
  support = await createStaff(srv.base, ['support_agent']);
  auditor = await createStaff(srv.base, ['auditor']);
  alice = await registerCustomer(srv.base); bob = await registerCustomer(srv.base);
  await fund(alice.account.id, '100.00', accountant.id);
  const t = await alice.client.post('/api/v1/transfers/internal', { sourceAccountId: alice.account.id, recipientIdentifier: bob.account.public_identifier, amount: '10.00', pin: PIN }, { 'idempotency-key': uid() });
  ref = t.body.transaction.reference;
});
after(() => srv.close());

test('invariant 9: customers cannot read other customers\' accounts, transactions or receipts (IDOR)', async () => {
  const mallory = await registerCustomer(srv.base);
  for (const path of [`/api/v1/accounts/${alice.account.id}`, `/api/v1/accounts/${alice.account.id}/transactions`,
    `/api/v1/transactions/${ref}`, `/api/v1/transactions/${ref}/receipt`])
    assert.equal((await mallory.client.get(path)).status, 404, path);
  assert.equal((await alice.client.get(`/api/v1/transactions/${ref}`)).status, 200);
  assert.equal((await bob.client.get(`/api/v1/transactions/${ref}/receipt`)).status, 200);
});

test('invariant 3: users cannot move funds from accounts they do not own, or without auth', async () => {
  const mallory = await registerCustomer(srv.base);
  const steal = await mallory.client.post('/api/v1/transfers/internal', { sourceAccountId: alice.account.id, recipientIdentifier: mallory.account.public_identifier, amount: '5.00', pin: PIN }, { 'idempotency-key': uid() });
  assert.equal(steal.status, 404);
  assert.equal((await new Client(srv.base).post('/api/v1/transfers/internal', {})).status, 401);
  assert.equal((await alice.client.get('/api/v1/accounts')).body.accounts[0].balances.ledger_balance, '90.00');
});

test('customer sessions cannot reach admin APIs; unauthenticated requests are rejected', async () => {
  for (const p of ['/api/v1/admin/customers?q=test', '/api/v1/admin/adjustments', '/api/v1/admin/audit-logs', '/api/v1/admin/ledger'])
    assert.equal((await alice.client.get(p)).status, 401, p);
  const anon = new Client(srv.base);
  assert.equal((await anon.get('/api/v1/me')).status, 401);
  assert.equal((await anon.get('/api/v1/admin/adjustments')).status, 401);
  // a customer cookie planted in the staff cookie slot must not work either
  const swap = new Client(srv.base); swap.jar.zb_staff_session = alice.client.jar.zb_session;
  assert.equal((await swap.get('/api/v1/admin/adjustments')).status, 401);
});

test('invariant 8: support agents and auditors cannot create, approve or change balances', async () => {
  const body = { customerAccountId: bob.account.id, direction: 'credit', amount: '10.00', reasonCode: 'CORRECTION_CREDIT', explanation: 'Attempted by wrong role', internalReference: 'X-1' };
  for (const s of [support, auditor]) {
    assert.equal((await s.client.post('/api/v1/admin/adjustments', body, { 'idempotency-key': uid() })).status, 403);
    assert.equal((await s.client.post(`/api/v1/admin/adjustments/${uid()}/approve`, {})).status, 403);
    assert.equal((await s.client.put('/api/v1/admin/adjustment-limits/NGN', { autoPostLimit: '999999999', dualApprovalLimit: '999999999' })).status, 403);
  }
  assert.equal((await support.client.get('/api/v1/admin/ledger?customerAccountId=' + bob.account.id)).status, 403);
  assert.equal((await support.client.get('/api/v1/admin/customers?q=Ada')).status, 403);
  assert.equal((await auditor.client.get('/api/v1/admin/audit-logs')).status, 200);
});

test('there is no API or SQL path that edits a balance or deletes a ledger transaction', async () => {
  for (const [m, p] of [['PUT', `/api/v1/admin/accounts/${bob.account.id}`], ['PATCH', `/api/v1/admin/accounts/${bob.account.id}`],
    ['DELETE', `/api/v1/admin/transactions/${ref}`], ['PUT', `/api/v1/accounts/${bob.account.id}`]]) {
    const r = await accountant.client.req(m, p, { balance: '999999' });
    assert.ok([401, 403, 404].includes(r.status), `${m} ${p} -> ${r.status}`);
  }
  assert.equal(Object.keys((await query(`SELECT * FROM customer_accounts LIMIT 1`)).fields.map(f => f.name)).includes('balance'), false);
  assert.equal((await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'customer_accounts' AND column_name ILIKE '%balance%'`)).rowCount, 0, 'balance is not a stored column');
  assert.equal((await bob.client.get(`/api/v1/accounts/${bob.account.id}`)).body.balances.ledger_balance, '10.00');
});

test('staff tokens: admin APIs enforce CSRF and sessions are revocable', async () => {
  const s = await createStaff(srv.base, ['accountant']);
  const bad = await s.client.post('/api/v1/admin/adjustments', {}, { 'x-csrf-token': 'wrong', 'idempotency-key': uid() });
  assert.equal(bad.status, 403);
  const old = s.client.jar.zb_staff_session;
  await s.client.post('/api/v1/admin/auth/logout');
  const replay = new Client(srv.base); replay.jar.zb_staff_session = old;
  assert.equal((await replay.get('/api/v1/admin/adjustments')).status, 401);
});

test('admin customer lookup works for permitted staff, validates input, and is audited', async () => {
  const r = await accountant.client.get(`/api/v1/admin/customers?q=${alice.account.public_identifier}`);
  assert.equal(r.status, 200); assert.equal(r.body.customers.length, 1);
  assert.equal((await accountant.client.get('/api/v1/admin/customers?q=a')).status, 422);
  const detail = await accountant.client.get(`/api/v1/admin/customers/${r.body.customers[0].id}`);
  assert.equal(detail.body.accounts[0].balances.ledger_balance, '90.00');
  assert.ok(!('password_hash' in detail.body));
  assert.ok((await query(`SELECT 1 FROM audit_logs WHERE action = 'customer.viewed' AND actor_id = $1`, [accountant.id])).rowCount >= 1);
});

test('responses carry security headers and no stack traces; malformed input is handled safely', async () => {
  const c = new Client(srv.base);
  const r = await c.get('/healthz');
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('x-content-type-options') === 'nosniff' && !r.headers.get('x-powered-by'));
  const bad = await fetch(srv.base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  const sqli = await c.post('/api/v1/auth/login', { email: "x'; DROP TABLE users;--@a.com", password: 'x' });
  assert.equal(sqli.status, 422);
  assert.ok((await query('SELECT count(*) FROM users')).rows[0].count > 0);
});
