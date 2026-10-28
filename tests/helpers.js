import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { closePool, query } from '../src/database/pool.js';
import { hashSecret } from '../src/modules/auth/auth.service.js';
import { createAdjustment } from '../src/modules/accounting/adjustments.service.js';

export const PASSWORD = 'Correct-Horse-Battery-9';
export const PIN = '482916';
export const uid = () => crypto.randomUUID();

export async function startServer() {
  const server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: async () => { await new Promise(r => server.close(r)); await closePool(); } };
}

export class Client {
  constructor(base) { this.base = base; this.jar = {}; }
  async req(method, path, body, headers = {}) {
    const staff = path.startsWith('/api/v1/admin');
    const csrf = this.jar[staff ? 'zb_staff_csrf' : 'zb_csrf'];
    const h = { 'content-type': 'application/json', ...headers };
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (csrf && !('x-csrf-token' in h)) h['x-csrf-token'] = csrf;
    const res = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split('; ');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      if (!value) delete this.jar[name]; else this.jar[name] = value;
      this.lastSetCookie = { ...(this.lastSetCookie ?? {}), [name]: attrs.join('; ') };
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  get = (p, h) => this.req('GET', p, undefined, h);
  post = (p, b = {}, h) => this.req('POST', p, b, h);
  put = (p, b = {}, h) => this.req('PUT', p, b, h);
}

export async function registerCustomer(base, { country = 'NG', verify = true, pin = true } = {}) {
  const client = new Client(base);
  const email = `${uid()}@test.zenvobank.local`;
  const reg = await client.post('/api/v1/auth/register', { email, password: PASSWORD, fullName: 'Ada Okafor', countryCode: country });
  if (reg.status !== 201) throw new Error('register failed ' + JSON.stringify(reg.body));
  if (verify) await client.post('/api/v1/auth/verify-email', { token: reg.body.devVerificationToken });
  const login = await client.post('/api/v1/auth/login', { email, password: PASSWORD });
  if (login.status !== 200) throw new Error('login failed ' + JSON.stringify(login.body));
  if (pin) await client.post('/api/v1/me/pin', { password: PASSWORD, pin: PIN });
  return { client, email, userId: login.body.user.id, account: reg.body.account };
}

export async function createStaff(base, roleCodes) {
  const email = `${uid()}@staff.zenvobank.local`;
  const { rows } = await query(`INSERT INTO staff_users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id`,
    [email, `Staff ${roleCodes.join('+')}`, await hashSecret(PASSWORD)]);
  await query(`INSERT INTO staff_role_assignments (staff_id, role_id) SELECT $1, id FROM roles WHERE code = ANY($2)`, [rows[0].id, roleCodes]);
  const client = new Client(base);
  const r = await client.post('/api/v1/admin/auth/login', { email, password: PASSWORD });
  if (r.status !== 200) throw new Error('staff login failed ' + JSON.stringify(r.body));
  return { client, id: rows[0].id, email };
}

export const setLimits = (ccy, auto, dual) => query(
  `INSERT INTO adjustment_limits (currency, auto_post_limit, dual_approval_limit) VALUES ($1,$2,$3)
   ON CONFLICT (currency) DO UPDATE SET auto_post_limit = EXCLUDED.auto_post_limit, dual_approval_limit = EXCLUDED.dual_approval_limit`, [ccy, auto, dual]);

/** Test-only funding through the real adjustment service (auto-post path). Requires NGN limits to be configured. */
export async function fund(accountId, amount, staffId) {
  const staff = { id: staffId, permissions: new Set(['adjustments.post_small', 'adjustments.create']) };
  const out = await createAdjustment({ staff, idempotencyKey: uid(), ip: null, input: {
    customerAccountId: accountId, direction: 'credit', amount, reasonCode: 'CORRECTION_CREDIT',
    explanation: 'Test fixture funding (simulated money)', internalReference: 'TEST-FIXTURE' } });
  if (out.adjustment.status !== 'posted') throw new Error('fixture funding did not post: ' + out.adjustment.status);
  return out.adjustment;
}

export const balanceOf = async (client, accountId) => (await client.get(`/api/v1/accounts/${accountId}`)).body.balances;
