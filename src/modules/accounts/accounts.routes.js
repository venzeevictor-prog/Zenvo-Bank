import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../database/pool.js';
import { requireUser } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { notFound } from '../../utils/errors.js';
import { formatDb } from '../../utils/money.js';
import { getBalances, publicBalances } from '../ledger/ledger.service.js';
import { setPin } from '../auth/auth.service.js';

export const publicRouter = Router();
publicRouter.get('/countries', async (_req, res) => {
  const { rows } = await query(
    `SELECT code, name, calling_code, default_currency FROM countries WHERE onboarding_enabled ORDER BY name`);
  res.json({ countries: rows });
});

export const customerRouter = Router();
customerRouter.use(requireUser);

const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) });
const maskName = (n) => n.split(/\s+/).map(p => p[0] + '*'.repeat(Math.max(2, p.length - 1))).join(' ');

customerRouter.get('/me', async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.status, u.country_code, u.preferred_language, u.display_currency, u.kyc_status,
            u.email_verified_at IS NOT NULL AS email_verified, u.tx_pin_hash IS NOT NULL AS has_pin, p.full_name
       FROM users u JOIN user_profiles p ON p.user_id = u.id WHERE u.id = $1`, [req.user.id]);
  res.json(rows[0]);
});

customerRouter.post('/me/pin', validate(z.object({ password: z.string().min(1), pin: z.string().regex(/^\d{6}$/) })), async (req, res) => {
  await setPin(req.user.id, req.validated.password, req.validated.pin);
  res.status(204).end();
});

customerRouter.get('/accounts', async (req, res) => {
  const { rows } = await query(
    `SELECT id, public_identifier, currency, status, is_test, created_at FROM customer_accounts WHERE user_id = $1 AND status <> 'closed' ORDER BY created_at`, [req.user.id]);
  const accounts = [];
  for (const a of rows) accounts.push({ ...a, balances: publicBalances(await getBalances({ query }, a.id)) });
  res.json({ accounts });
});

async function ownAccount(req) {
  const { rows } = await query('SELECT * FROM customer_accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows[0]) throw notFound('Account not found'); // 404 (not 403) so ids of other customers' accounts are not revealed
  return rows[0];
}
customerRouter.get('/accounts/:id', async (req, res) => {
  const a = await ownAccount(req);
  res.json({ id: a.id, public_identifier: a.public_identifier, currency: a.currency, status: a.status, is_test: a.is_test,
    balances: publicBalances(await getBalances({ query }, a.id)) });
});

customerRouter.get('/accounts/:id/transactions', validate(page, 'query'), async (req, res) => {
  const a = await ownAccount(req);
  const dec = (await query('SELECT decimals FROM currencies WHERE code = $1', [a.currency])).rows[0].decimals;
  const { limit, offset } = req.validatedQuery;
  const { rows } = await query(
    `SELECT t.reference, t.type, t.status, t.description, t.currency, t.is_test, t.created_at,
            CASE p.direction WHEN 'C' THEN 'credit' ELSE 'debit' END AS direction, p.amount
       FROM ledger_postings p
       JOIN journal_entries j ON j.id = p.journal_entry_id
       JOIN financial_transactions t ON t.id = j.financial_transaction_id
      WHERE p.ledger_account_id = $1 ORDER BY p.id DESC LIMIT $2 OFFSET $3`, [a.ledger_account_id, limit, offset]);
  res.json({ transactions: rows.map(r => ({ ...r, amount: formatDb(r.amount, dec) })), limit, offset });
});

async function ownTransaction(req) {
  const { rows } = await query(
    `SELECT t.*, c.decimals, fa.user_id AS from_user, ta.user_id AS to_user,
            fa.public_identifier AS from_ident, ta.public_identifier AS to_ident,
            (SELECT full_name FROM user_profiles WHERE user_id = fa.user_id) AS from_name,
            (SELECT full_name FROM user_profiles WHERE user_id = ta.user_id) AS to_name
       FROM financial_transactions t
       JOIN currencies c ON c.code = t.currency
       LEFT JOIN customer_accounts fa ON fa.id = t.from_account_id
       LEFT JOIN customer_accounts ta ON ta.id = t.to_account_id
      WHERE t.reference = $1 AND (fa.user_id = $2 OR ta.user_id = $2)`, [req.params.reference, req.user.id]);
  if (!rows[0]) throw notFound('Transaction not found');
  return rows[0];
}
function shape(t, userId) {
  const outgoing = t.from_user === userId;
  const cp = outgoing ? { name: t.to_name, ident: t.to_ident } : { name: t.from_name, ident: t.from_ident };
  return {
    reference: t.reference, type: t.type, status: t.status,
    direction: outgoing ? 'debit' : 'credit',
    amount: formatDb(t.amount, t.decimals), currency: t.currency, fee: formatDb('0', t.decimals),
    description: t.description, created_at: t.created_at, is_test: t.is_test,
    counterparty: cp.name ? { name: maskName(cp.name), account: cp.ident.slice(0, 4) + '****' + cp.ident.slice(-3) } : { name: 'ZenvoBank' },
  };
}
customerRouter.get('/transactions/:reference', async (req, res) => {
  res.json(shape(await ownTransaction(req), req.user.id));
});
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
customerRouter.get('/transactions/:reference/receipt', async (req, res) => {
  const r = shape(await ownTransaction(req), req.user.id);
  if (req.query.format !== 'html') return res.json({ receipt: { issuer: 'ZenvoBank', ...r, ...(r.is_test ? { notice: 'TEST TRANSACTION - simulated funds' } : {}) } });
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Receipt ${esc(r.reference)}</title>
<h1>ZenvoBank</h1>${r.is_test ? '<p><strong>TEST TRANSACTION - simulated funds</strong></p>' : ''}
<table><tr><th>Reference</th><td>${esc(r.reference)}</td></tr><tr><th>Type</th><td>${esc(r.type)}</td></tr>
<tr><th>Status</th><td>${esc(r.status)}</td></tr><tr><th>Amount</th><td>${esc(r.amount)} ${esc(r.currency)} (${esc(r.direction)})</td></tr>
<tr><th>Fee</th><td>${esc(r.fee)} ${esc(r.currency)}</td></tr><tr><th>Counterparty</th><td>${esc(r.counterparty.name)} ${esc(r.counterparty.account ?? '')}</td></tr>
<tr><th>Date (UTC)</th><td>${esc(new Date(r.created_at).toISOString())}</td></tr></table>`);
});

customerRouter.get('/notifications', validate(page, 'query'), async (req, res) => {
  const { limit, offset } = req.validatedQuery;
  const { rows } = await query(
    'SELECT id, type, title, body, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [req.user.id, limit, offset]);
  res.json({ notifications: rows, limit, offset });
});
