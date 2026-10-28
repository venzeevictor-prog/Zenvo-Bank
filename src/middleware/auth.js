import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { query } from '../database/pool.js';
import { forbidden, unauthorized } from '../utils/errors.js';

export const CUSTOMER_COOKIE = 'zb_session';
export const STAFF_COOKIE = 'zb_staff_session';
const CSRF = { customer: 'zb_csrf', staff: 'zb_staff_csrf' };

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function setSessionCookies(res, kind, token, ttlMs) {
  const base = { secure: config.isProd, sameSite: 'strict', maxAge: ttlMs, path: '/' };
  res.cookie(kind === 'staff' ? STAFF_COOKIE : CUSTOMER_COOKIE, token, { ...base, httpOnly: true });
  res.cookie(CSRF[kind], newToken(), { ...base, httpOnly: false }); // double-submit CSRF token
}
export function clearSessionCookies(res, kind) {
  res.clearCookie(kind === 'staff' ? STAFF_COOKIE : CUSTOMER_COOKIE, { path: '/' });
  res.clearCookie(CSRF[kind], { path: '/' });
}

function checkCsrf(req, kind) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const cookie = req.cookies?.[CSRF[kind]];
  const header = req.get('x-csrf-token');
  const ok = cookie && header && cookie.length === header.length &&
    crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
  if (!ok) throw forbidden('CSRF token missing or invalid');
}

export async function requireUser(req, _res, next) {
  const token = req.cookies?.[CUSTOMER_COOKIE];
  if (!token) throw unauthorized();
  const { rows } = await query(
    `SELECT s.id AS session_id, u.id, u.email, u.status, u.country_code, u.display_currency, u.kyc_status, u.tx_pin_hash IS NOT NULL AS has_pin
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.kind = 'customer' AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL`,
    [hashToken(token)]);
  if (!rows[0] || rows[0].status === 'closed') throw unauthorized();
  checkCsrf(req, 'customer');
  req.user = rows[0];
  next();
}

export async function requireStaff(req, _res, next) {
  const token = req.cookies?.[STAFF_COOKIE];
  if (!token) throw unauthorized();
  const { rows } = await query(
    `SELECT s.id AS session_id, st.id, st.email, st.full_name,
            COALESCE(array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
       FROM user_sessions s
       JOIN staff_users st ON st.id = s.staff_id AND st.status = 'active'
       LEFT JOIN staff_role_assignments sra ON sra.staff_id = st.id
       LEFT JOIN role_permissions rp ON rp.role_id = sra.role_id
      WHERE s.token_hash = $1 AND s.kind = 'staff' AND s.revoked_at IS NULL AND s.expires_at > now()
      GROUP BY s.id, st.id`, [hashToken(token)]);
  if (!rows[0]) throw unauthorized();
  checkCsrf(req, 'staff');
  req.staff = { ...rows[0], permissions: new Set(rows[0].permissions) };
  next();
}

/** Backend-enforced permission check. All listed permissions are required. */
export const requirePermission = (...codes) => (req, _res, next) => {
  const missing = codes.filter(c => !req.staff.permissions.has(c));
  if (missing.length) throw forbidden(`Missing permission: ${missing.join(', ')}`);
  next();
};
