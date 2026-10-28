import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../src/database/pool.js';
import { Client, PASSWORD, startServer, registerCustomer, uid } from '../helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('registration: country sets default currency, account is test-flagged and pending until email verified', async () => {
  const c = new Client(srv.base);
  const email = `${uid()}@test.zenvobank.local`;
  const r = await c.post('/api/v1/auth/register', { email, password: PASSWORD, fullName: 'Kofi Mensah', countryCode: 'gh' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.display_currency, 'GHS');
  assert.equal(r.body.account.currency, 'GHS');
  assert.match(r.body.account.public_identifier, /^ZB\d{10}$/);
  assert.equal(r.body.account.status, 'pending');
  assert.ok(!JSON.stringify(r.body).includes('password'));
  const row = (await query('SELECT is_test, password_hash FROM customer_accounts a JOIN users u ON u.id = a.user_id WHERE a.id = $1', [r.body.account.id])).rows[0];
  assert.equal(row.is_test, true);
  assert.match(row.password_hash, /^\$argon2id\$/);
  await c.post('/api/v1/auth/login', { email, password: PASSWORD });
  assert.equal((await c.get('/api/v1/accounts')).body.accounts[0].status, 'pending');
  const v = await c.post('/api/v1/auth/verify-email', { token: r.body.devVerificationToken });
  assert.equal(v.status, 200);
  assert.equal((await c.get('/api/v1/accounts')).body.accounts[0].status, 'active');
  assert.equal((await c.post('/api/v1/auth/verify-email', { token: r.body.devVerificationToken })).status, 422, 'token is single-use');
});

test('registration: unsupported country, duplicate email, weak password, bad input', async () => {
  const c = new Client(srv.base);
  const base = { email: `${uid()}@test.zenvobank.local`, password: PASSWORD, fullName: 'Test User' };
  assert.equal((await c.post('/api/v1/auth/register', { ...base, countryCode: 'DE' })).body.error.code, 'country_not_supported');
  assert.equal((await c.post('/api/v1/auth/register', { ...base, countryCode: 'ZZ' })).body.error.code, 'unknown_country');
  assert.equal((await c.post('/api/v1/auth/register', { ...base, countryCode: 'NG', password: 'short' })).status, 422);
  assert.equal((await c.post('/api/v1/auth/register', { ...base, email: 'nope', countryCode: 'NG' })).status, 422);
  assert.equal((await c.post('/api/v1/auth/register', { ...base, countryCode: 'NG' })).status, 201);
  assert.equal((await c.post('/api/v1/auth/register', { ...base, email: base.email.toUpperCase(), countryCode: 'NG' })).status, 409);
});

test('countries endpoint lists only onboarding-enabled countries with their default currency', async () => {
  const r = await new Client(srv.base).get('/api/v1/countries');
  const byCode = Object.fromEntries(r.body.countries.map(c => [c.code, c]));
  assert.equal(byCode.NG.default_currency, 'NGN'); assert.equal(byCode.US.default_currency, 'USD'); assert.equal(byCode.GB.default_currency, 'GBP');
  assert.equal(byCode.DE, undefined);
});

test('login: cookies are HttpOnly + SameSite=Strict; wrong password is generic; logout revokes the session', async () => {
  const { client, email } = await registerCustomer(srv.base);
  assert.match(client.lastSetCookie.zb_session, /HttpOnly/i);
  assert.match(client.lastSetCookie.zb_session, /SameSite=Strict/i);
  const bad = await new Client(srv.base).post('/api/v1/auth/login', { email, password: 'wrong-password-123' });
  const none = await new Client(srv.base).post('/api/v1/auth/login', { email: 'nobody@test.zenvobank.local', password: 'wrong-password-123' });
  assert.equal(bad.status, 401); assert.deepEqual(bad.body, none.body, 'no user enumeration');
  assert.equal((await client.get('/api/v1/me')).status, 200);
  const stolen = client.jar.zb_session;
  assert.equal((await client.post('/api/v1/auth/logout')).status, 204);
  const replay = new Client(srv.base); replay.jar.zb_session = stolen;
  assert.equal((await replay.get('/api/v1/me')).status, 401, 'revoked session token is dead');
});

test('login throttling: account locks after repeated failures', async () => {
  const { email } = await registerCustomer(srv.base);
  const c = new Client(srv.base);
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/v1/auth/login', { email, password: 'wrong-password-123' })).status, 401);
  const locked = await c.post('/api/v1/auth/login', { email, password: PASSWORD });
  assert.equal(locked.status, 429); assert.equal(locked.body.error.code, 'account_locked');
});

test('CSRF: state-changing authenticated requests need the matching token', async () => {
  const { client } = await registerCustomer(srv.base, { pin: false });
  const noToken = await client.post('/api/v1/me/pin', { password: PASSWORD, pin: '482916' }, { 'x-csrf-token': '' });
  assert.equal(noToken.status, 403);
  const wrong = await client.post('/api/v1/me/pin', { password: PASSWORD, pin: '482916' }, { 'x-csrf-token': 'nope' });
  assert.equal(wrong.status, 403);
  assert.equal((await client.post('/api/v1/me/pin', { password: PASSWORD, pin: '482916' })).status, 204);
});

test('PIN: weak PINs refused, wrong PIN locks after 5 tries, PIN stored hashed', async () => {
  const { client, userId, account } = await registerCustomer(srv.base, { pin: false });
  assert.equal((await client.post('/api/v1/me/pin', { password: PASSWORD, pin: '111111' })).body.error.code, 'weak_pin');
  assert.equal((await client.post('/api/v1/me/pin', { password: 'wrong-password-123', pin: '482916' })).status, 401);
  await client.post('/api/v1/me/pin', { password: PASSWORD, pin: '482916' });
  assert.match((await query('SELECT tx_pin_hash FROM users WHERE id = $1', [userId])).rows[0].tx_pin_hash, /^\$argon2id\$/);
  const other = await registerCustomer(srv.base);
  const t = () => client.post('/api/v1/transfers/internal', { sourceAccountId: account.id, recipientIdentifier: other.account.public_identifier, amount: '1.00', pin: '135790' }, { 'idempotency-key': uid() });
  for (let i = 0; i < 5; i++) assert.equal((await t()).body.error.code, 'invalid_pin');
  assert.equal((await t()).body.error.code, 'pin_locked');
});
