import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../database/pool.js';
import { requirePermission, requireStaff } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit, notify } from '../../services/audit.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { formatDb } from '../../utils/money.js';
import { getBalances, lockCustomerAccounts, publicBalances } from '../ledger/ledger.service.js';
import * as adj from '../accounting/adjustments.service.js';

export const adminRouter = Router();
adminRouter.use(requireStaff);

const page = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

// ----- Customers -----
adminRouter.get('/customers', requirePermission('customers.read'),
  validate(page.extend({ q: z.string().trim().min(2).max(100) }), 'query'), async (req, res) => {
    const { q, limit, offset } = req.validatedQuery;
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const { rows } = await query(
      `SELECT DISTINCT u.id, u.email, p.full_name, u.country_code, u.status, u.kyc_status
         FROM users u JOIN user_profiles p ON p.user_id = u.id
         LEFT JOIN customer_accounts a ON a.user_id = u.id
        WHERE u.deleted_at IS NULL AND (u.id::text = $1 OR u.email ILIKE $2 OR p.full_name ILIKE $2 OR a.public_identifier = $1)
        ORDER BY p.full_name LIMIT $3 OFFSET $4`, [q, like, limit, offset]);
    res.json({ customers: rows, limit, offset });
  });

adminRouter.get('/customers/:id', requirePermission('customers.read'), async (req, res) => {
  if (!z.uuid().safeParse(req.params.id).success) throw notFound('Customer not found');
  const u = (await query(
    `SELECT u.id, u.email, u.status, u.country_code, u.display_currency, u.kyc_status, u.email_verified_at, u.created_at, p.full_name
       FROM users u JOIN user_profiles p ON p.user_id = u.id WHERE u.id = $1`, [req.params.id])).rows[0];
  if (!u) throw notFound('Customer not found');
  const accts = (await query(`SELECT id, public_identifier, currency, status, is_test FROM customer_accounts WHERE user_id = $1 ORDER BY created_at`, [u.id])).rows;
  const accounts = [];
  for (const a of accts) accounts.push({ ...a, balances: publicBalances(await getBalances({ query }, a.id)) });
  await query(`INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, ip) VALUES ('staff',$1,'customer.viewed','user',$2,$3)`, [req.staff.id, u.id, req.ip]);
  res.json({ ...u, accounts });
});

adminRouter.post('/accounts/:id/status', requirePermission('accounts.restrict'),
  validate(z.object({ status: z.enum(['active', 'restricted']), reason: z.string().trim().min(10).max(500) })), async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) throw notFound('Account not found');
    const out = await withTx(async (client) => {
      const a = (await lockCustomerAccounts(client, [req.params.id]))[req.params.id];
      if (a.status === 'pending' || a.status === 'closed') throw badRequest('invalid_transition', `Cannot change a ${a.status} account`);
      await client.query('UPDATE customer_accounts SET status = $2, updated_at = now() WHERE id = $1', [a.id, req.validated.status]);
      await audit(client, { actorType: 'staff', actorId: req.staff.id, action: `account.${req.validated.status}`, entityType: 'customer_account', entityId: a.id, ip: req.ip,
        details: { from: a.status, reason: req.validated.reason } });
      if (req.validated.status === 'restricted') await notify(client, a.user_id, 'security', 'Account restricted', 'Your account has been restricted. Please contact support.');
      return { id: a.id, status: req.validated.status };
    });
    res.json(out);
  });

// ----- Ledger & reconciliation -----
adminRouter.get('/ledger', requirePermission('ledger.read'),
  validate(page.extend({ customerAccountId: z.uuid().optional(), ledgerAccountCode: z.string().max(80).optional() }), 'query'), async (req, res) => {
    const { customerAccountId, ledgerAccountCode, limit, offset } = req.validatedQuery;
    if (!customerAccountId && !ledgerAccountCode) throw badRequest('filter_required', 'Provide customerAccountId or ledgerAccountCode');
    const { rows } = await query(
      `SELECT p.id, j.id AS journal_entry_id, t.reference, t.type, t.status, t.is_test, la.code AS ledger_account, p.direction, p.amount, p.currency, j.posted_at, j.description
         FROM ledger_postings p JOIN journal_entries j ON j.id = p.journal_entry_id
         JOIN financial_transactions t ON t.id = j.financial_transaction_id JOIN ledger_accounts la ON la.id = p.ledger_account_id
        WHERE la.id = (SELECT ledger_account_id FROM customer_accounts WHERE id = $1) OR la.code = $2
        ORDER BY p.id DESC LIMIT $3 OFFSET $4`, [customerAccountId ?? null, ledgerAccountCode ?? null, limit, offset]);
    const dec = Object.fromEntries((await query('SELECT code, decimals FROM currencies')).rows.map(c => [c.code, c.decimals]));
    res.json({ postings: rows.map(r => ({ ...r, amount: formatDb(r.amount, dec[r.currency]) })), limit, offset });
  });

adminRouter.get('/reconciliation/ledger-integrity', requirePermission('reconciliation.read'), async (_req, res) => {
  const unbalanced = (await query(
    `SELECT journal_entry_id,
            SUM(amount) FILTER (WHERE direction='D') AS debits, SUM(amount) FILTER (WHERE direction='C') AS credits
       FROM ledger_postings GROUP BY journal_entry_id
     HAVING COALESCE(SUM(amount) FILTER (WHERE direction='D'),0) <> COALESCE(SUM(amount) FILTER (WHERE direction='C'),0)`)).rows;
  const trial = (await query(
    `SELECT currency, SUM(amount) FILTER (WHERE direction='D') AS debits, SUM(amount) FILTER (WHERE direction='C') AS credits
       FROM ledger_postings GROUP BY currency ORDER BY currency`)).rows;
  const negative = (await query(
    `SELECT la.code, SUM(CASE p.direction WHEN 'C' THEN p.amount ELSE -p.amount END) AS balance
       FROM ledger_accounts la JOIN ledger_postings p ON p.ledger_account_id = la.id WHERE la.is_customer
      GROUP BY la.code HAVING SUM(CASE p.direction WHEN 'C' THEN p.amount ELSE -p.amount END) < 0`)).rows;
  const orphan = (await query(
    `SELECT t.reference FROM financial_transactions t
      WHERE t.status IN ('completed','reversed') AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.financial_transaction_id = t.id)`)).rows;
  const trialBalanced = trial.every(t => t.debits === t.credits);
  res.json({ ok: !unbalanced.length && trialBalanced && !negative.length && !orphan.length,
    unbalanced_entries: unbalanced, trial_balance_by_currency: trial, negative_customer_balances: negative, completed_without_postings: orphan,
    note: 'Operational integrity check of the internal ledger. Provider/bank reconciliation is not connected yet.' });
});

// ----- Adjustments -----
const adjustmentSchema = z.object({
  customerAccountId: z.uuid(),
  direction: z.enum(['credit', 'debit']),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  reasonCode: z.string().min(3).max(40),
  explanation: z.string().trim().min(10).max(1000),
  internalReference: z.string().trim().min(3).max(100),
  externalReference: z.string().trim().min(3).max(100).optional(),
  evidenceRef: z.string().trim().max(300).optional(),
});
const idKey = (req) => {
  const k = req.get('idempotency-key');
  if (!k || k.length < 8 || k.length > 100) throw badRequest('idempotency_key_required', 'Idempotency-Key header (8-100 chars) is required');
  return k;
};
const uuidParam = (req) => { if (!z.uuid().safeParse(req.params.id).success) throw notFound('Adjustment not found'); return req.params.id; };

adminRouter.get('/adjustment-reasons', requirePermission('adjustments.read'), async (_req, res) => {
  res.json({ reasons: (await query('SELECT code, name, direction, requires_external_reference, enabled FROM adjustment_reasons ORDER BY direction, code')).rows });
});
adminRouter.post('/adjustments', requirePermission('adjustments.create'), validate(adjustmentSchema), async (req, res) => {
  const out = await adj.createAdjustment({ staff: req.staff, input: req.validated, idempotencyKey: idKey(req), ip: req.ip });
  res.status(out.replayed ? 200 : 201).json(out);
});
adminRouter.get('/adjustments', requirePermission('adjustments.read'),
  validate(page.extend({ status: z.enum(['pending_approval', 'posted', 'rejected']).optional() }), 'query'), async (req, res) => {
    res.json({ adjustments: await adj.listAdjustments(req.validatedQuery), ...page.parse(req.query) });
  });
adminRouter.get('/adjustments/:id', requirePermission('adjustments.read'), async (req, res) => {
  res.json(await adj.getAdjustment(uuidParam(req)));
});
adminRouter.post('/adjustments/:id/approve', requirePermission('adjustments.approve'),
  validate(z.object({ comment: z.string().max(500).optional() })), async (req, res) => {
    res.json(await adj.approveAdjustment({ staff: req.staff, id: uuidParam(req), comment: req.validated.comment, ip: req.ip }));
  });
adminRouter.post('/adjustments/:id/reject', requirePermission('adjustments.approve'),
  validate(z.object({ reason: z.string().trim().min(5).max(500) })), async (req, res) => {
    res.json(await adj.rejectAdjustment({ staff: req.staff, id: uuidParam(req), reason: req.validated.reason, ip: req.ip }));
  });

adminRouter.put('/adjustment-limits/:currency', requirePermission('settings.manage'),
  validate(z.object({ autoPostLimit: z.string().regex(/^\d+(\.\d+)?$/), dualApprovalLimit: z.string().regex(/^\d+(\.\d+)?$/) })), async (req, res) => {
    const ccy = String(req.params.currency).toUpperCase();
    await withTx(async (client) => {
      const c = (await client.query('SELECT 1 FROM currencies WHERE code = $1', [ccy])).rowCount;
      if (!c) throw notFound('Currency not found');
      await client.query(
        `INSERT INTO adjustment_limits (currency, auto_post_limit, dual_approval_limit) VALUES ($1,$2,$3)
         ON CONFLICT (currency) DO UPDATE SET auto_post_limit = EXCLUDED.auto_post_limit, dual_approval_limit = EXCLUDED.dual_approval_limit, updated_at = now()`,
        [ccy, req.validated.autoPostLimit, req.validated.dualApprovalLimit]);
      await audit(client, { actorType: 'staff', actorId: req.staff.id, action: 'settings.adjustment_limits_changed', entityType: 'currency', entityId: ccy, ip: req.ip, details: req.validated });
    });
    res.json({ currency: ccy, ...req.validated });
  });

// ----- Audit -----
adminRouter.get('/audit-logs', requirePermission('audit.read'),
  validate(page.extend({ action: z.string().max(80).optional(), entityId: z.string().max(80).optional() }), 'query'), async (req, res) => {
    const { action, entityId, limit, offset } = req.validatedQuery;
    const { rows } = await query(
      `SELECT id, actor_type, actor_id, action, entity_type, entity_id, ip, details, created_at FROM audit_logs
        WHERE ($1::text IS NULL OR action = $1) AND ($2::text IS NULL OR entity_id = $2) ORDER BY id DESC LIMIT $3 OFFSET $4`,
      [action ?? null, entityId ?? null, limit, offset]);
    res.json({ logs: rows, limit, offset });
  });
