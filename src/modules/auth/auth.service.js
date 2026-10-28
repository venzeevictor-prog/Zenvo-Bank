import crypto from 'node:crypto';
import argon2 from 'argon2';
import { config } from '../../config/index.js';
import { query, withTx } from '../../database/pool.js';
import { audit, notify } from '../../services/audit.js';
import { sendMail } from '../../services/mailer.js';
import { conflict, unauthorized, unprocessable, AppError } from '../../utils/errors.js';
import { hashToken, newToken } from '../../middleware/auth.js';
import { newReference } from '../ledger/ledger.service.js';

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashSecret = (s) => argon2.hash(s, ARGON);
let dummyHash;
const getDummy = async () => (dummyHash ??= await hashSecret('timing-equalisation-only'));

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

async function newPublicIdentifier(client) {
  for (let i = 0; i < 5; i++) {
    const id = 'ZB' + String(crypto.randomInt(0, 1e10)).padStart(10, '0');
    const { rowCount } = await client.query('SELECT 1 FROM customer_accounts WHERE public_identifier = $1', [id]);
    if (!rowCount) return id;
  }
  throw new AppError(500, 'id_generation_failed', 'Could not allocate account identifier');
}

/** Creates a customer account + its ledger account in `currency`. Account starts 'pending' until email is verified. */
export async function openCustomerAccount(client, userId, currency) {
  const pub = await newPublicIdentifier(client);
  const la = await client.query(
    `INSERT INTO ledger_accounts (code, name, type, currency, is_customer) VALUES ($1,$2,'liability',$3,true) RETURNING id`,
    [`CUST-${pub}`, `Customer account ${pub}`, currency]);
  const { rows } = await client.query(
    `INSERT INTO customer_accounts (user_id, public_identifier, currency, ledger_account_id, is_test)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, public_identifier, currency, status`,
    [userId, pub, currency, la.rows[0].id, config.accountsAreTest]);
  return rows[0];
}

export async function register(input, ip) {
  const result = await withTx(async (client) => {
    const country = (await client.query(
      `SELECT code, default_currency, onboarding_enabled FROM countries WHERE code = $1`, [input.countryCode])).rows[0];
    if (!country) throw unprocessable('unknown_country', 'Unknown country');
    if (!country.onboarding_enabled) throw unprocessable('country_not_supported', 'ZenvoBank is not yet available in this country');
    const hash = await hashSecret(input.password);
    let user;
    try {
      user = (await client.query(
        `INSERT INTO users (email, password_hash, country_code, preferred_language, display_currency, phone)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, status, country_code, display_currency`,
        [input.email.toLowerCase(), hash, country.code, input.preferredLanguage, country.default_currency, input.phone ?? null])).rows[0];
    } catch (e) {
      if (e.code === '23505') throw conflict('email_in_use', 'An account with this email already exists');
      throw e;
    }
    await client.query('INSERT INTO user_profiles (user_id, full_name, nationality) VALUES ($1,$2,$3)', [user.id, input.fullName, input.nationality ?? null]);
    const account = await openCustomerAccount(client, user.id, country.default_currency);
    const token = newToken();
    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '24 hours')`,
      [user.id, hashToken(token)]);
    await audit(client, { actorType: 'customer', actorId: user.id, action: 'customer.registered', entityType: 'user', entityId: user.id, ip });
    return { user, account, token };
  });
  await sendMail({ to: result.user.email, template: 'verify-email' });
  return { user: result.user, account: result.account, ...(config.exposeDevTokens ? { devVerificationToken: result.token } : {}) };
}

export async function verifyEmail(token) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id FROM email_verification_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [hashToken(token)]);
    if (!rows[0]) throw unprocessable('invalid_token', 'Verification link is invalid or expired');
    await client.query('UPDATE email_verification_tokens SET used_at = now() WHERE id = $1', [rows[0].id]);
    await client.query(`UPDATE users SET email_verified_at = now(), status = 'active', updated_at = now() WHERE id = $1 AND status = 'pending_verification'`, [rows[0].user_id]);
    await client.query(`UPDATE customer_accounts SET status = 'active', updated_at = now() WHERE user_id = $1 AND status = 'pending'`, [rows[0].user_id]);
    await audit(client, { actorType: 'customer', actorId: rows[0].user_id, action: 'customer.email_verified', entityType: 'user', entityId: rows[0].user_id });
    await notify(client, rows[0].user_id, 'account', 'Email verified', 'Your email is verified and your account is active.');
    return { verified: true };
  });
}

async function createSession(kind, ownerId, ip, userAgent, ttlHours) {
  const token = newToken();
  await query(
    `INSERT INTO user_sessions (kind, user_id, staff_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval)`,
    [kind, kind === 'customer' ? ownerId : null, kind === 'staff' ? ownerId : null, hashToken(token), ip, (userAgent || '').slice(0, 300), String(ttlHours)]);
  return { token, ttlMs: ttlHours * 3_600_000 };
}

async function authenticate(table, email, password) {
  const { rows } = await query(`SELECT * FROM ${table} WHERE lower(email) = lower($1)${table === 'users' ? ' AND deleted_at IS NULL' : ''}`, [email]);
  const row = rows[0];
  if (row?.locked_until && row.locked_until > new Date()) throw new AppError(429, 'account_locked', 'Too many failed attempts. Try again later.');
  const ok = await argon2.verify(row?.password_hash ?? await getDummy(), password).catch(() => false);
  if (!row || !ok) {
    if (row) await query(
      `UPDATE ${table} SET failed_logins = failed_logins + 1,
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' milliseconds')::interval ELSE locked_until END WHERE id = $1`,
      [row.id, MAX_FAILS, String(LOCK_MS)]);
    throw unauthorized('Invalid email or password');
  }
  await query(`UPDATE ${table} SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [row.id]);
  return row;
}

export async function loginCustomer({ email, password }, ip, ua) {
  const user = await authenticate('users', email, password);
  if (user.status === 'closed') throw unauthorized('Invalid email or password');
  const session = await createSession('customer', user.id, ip, ua, config.sessionTtlHours);
  await query(`INSERT INTO audit_logs (actor_type, actor_id, action, ip) VALUES ('customer',$1,'customer.login',$2)`, [user.id, ip]);
  return { user: { id: user.id, email: user.email, status: user.status }, session };
}

export async function loginStaff({ email, password }, ip, ua) {
  const staff = await authenticate('staff_users', email, password);
  if (staff.status !== 'active') throw unauthorized('Invalid email or password');
  // Privileged staff must use MFA in production. MFA enrolment is not implemented yet, so production staff login is blocked by design.
  if (config.isProd && !staff.mfa_enabled) throw new AppError(403, 'mfa_required', 'Multi-factor authentication is required for staff');
  const session = await createSession('staff', staff.id, ip, ua, config.staffSessionTtlHours);
  await query(`INSERT INTO audit_logs (actor_type, actor_id, action, ip) VALUES ('staff',$1,'staff.login',$2)`, [staff.id, ip]);
  return { staff: { id: staff.id, email: staff.email, full_name: staff.full_name }, session };
}

export const logout = (sessionId) => query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [sessionId]);

/** Transaction PIN: set (requires current password) and verify with lockout. */
export async function setPin(userId, password, pin) {
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!(await argon2.verify(rows[0].password_hash, password).catch(() => false))) throw unauthorized('Password is incorrect');
  if (/^(\d)\1+$/.test(pin) || '0123456789012345'.includes(pin) || '9876543210987654'.includes(pin))
    throw unprocessable('weak_pin', 'Choose a PIN that is not repeated or sequential');
  await query('UPDATE users SET tx_pin_hash = $2, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = now() WHERE id = $1', [userId, await hashSecret(pin)]);
  await query(`INSERT INTO audit_logs (actor_type, actor_id, action) VALUES ('customer',$1,'customer.pin_set')`, [userId]);
}

export async function verifyPin(userId, pin) {
  const { rows } = await query('SELECT tx_pin_hash, pin_failed_attempts, pin_locked_until FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u?.tx_pin_hash) throw new AppError(403, 'pin_not_set', 'Set a transaction PIN before sending money');
  if (u.pin_locked_until && u.pin_locked_until > new Date()) throw new AppError(429, 'pin_locked', 'PIN temporarily locked. Try again later.');
  if (!(await argon2.verify(u.tx_pin_hash, pin).catch(() => false))) {
    await query(
      `UPDATE users SET pin_failed_attempts = pin_failed_attempts + 1,
         pin_locked_until = CASE WHEN pin_failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE pin_locked_until END WHERE id = $1`, [userId]);
    throw new AppError(403, 'invalid_pin', 'Incorrect PIN');
  }
  await query('UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1', [userId]);
}
export { newReference };
