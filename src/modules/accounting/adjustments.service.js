import { query, withTx } from '../../database/pool.js';
import { config } from '../../config/index.js';
import { audit, notify } from '../../services/audit.js';
import { conflict, forbidden, notFound, unprocessable } from '../../utils/errors.js';
import { DB_SCALE, formatDb, parseAmount, toUnits } from '../../utils/money.js';
import {
  createFinancialTransaction, ensureSystemAccount, getBalances, hashRequest, lockCustomerAccounts, newReference, postJournal,
} from '../ledger/ledger.service.js';

async function postAdjustment(client, adj, actorStaffId, ip) {
  const acct = (await lockCustomerAccounts(client, [adj.customer_account_id]))[adj.customer_account_id];
  if (acct.status !== 'active') throw unprocessable('account_not_active', 'Account is not active');
  if (config.isProd && acct.is_test) throw forbidden('Test accounts cannot be adjusted in production');
  const reason = (await client.query('SELECT * FROM adjustment_reasons WHERE code = $1', [adj.reason_code])).rows[0];
  const amountText = formatDb(adj.amount, acct.decimals);
  if (adj.direction === 'debit') {
    const bal = await getBalances(client, acct.id);
    if (toUnits(adj.amount) > bal._units.available) throw unprocessable('insufficient_funds', 'Insufficient available funds for debit adjustment');
  }
  const counter = await ensureSystemAccount(client, reason.counter_role, adj.currency);
  const credit = adj.direction === 'credit';
  const tx = await createFinancialTransaction(client, {
    type: credit ? 'adjustment_credit' : 'adjustment_debit', currency: adj.currency, amount: amountText,
    description: `${reason.name} (${adj.reference})`, staffId: actorStaffId,
    fromAccountId: credit ? null : acct.id, toAccountId: credit ? acct.id : null, isTest: acct.is_test,
    metadata: { adjustment_id: adj.id, reason: adj.reason_code },
  });
  await postJournal(client, {
    transactionId: tx.id, description: `Adjustment ${adj.reference}: ${reason.name}`, currency: adj.currency,
    lines: credit
      ? [{ ledgerAccountId: counter, direction: 'D', amount: amountText }, { ledgerAccountId: acct.ledger_account_id, direction: 'C', amount: amountText }]
      : [{ ledgerAccountId: acct.ledger_account_id, direction: 'D', amount: amountText }, { ledgerAccountId: counter, direction: 'C', amount: amountText }],
  });
  const { rows } = await client.query(
    `UPDATE account_adjustments SET status = 'posted', financial_transaction_id = $2, decided_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
    [adj.id, tx.id]);
  await notify(client, acct.user_id, 'account', credit ? 'Account credited' : 'Account debited',
    `${credit ? 'Credit' : 'Debit'} of ${amountText} ${adj.currency} posted. Ref ${tx.reference}.`);
  await audit(client, { actorType: 'staff', actorId: actorStaffId, action: 'adjustment.posted', entityType: 'account_adjustment', entityId: adj.id, ip,
    details: { reference: adj.reference, financial_transaction: tx.reference } });
  return rows[0];
}

export async function createAdjustment({ staff, input, idempotencyKey, ip }) {
  return withTx(async (client) => {
    const acct = (await lockCustomerAccounts(client, [input.customerAccountId]))[input.customerAccountId];
    const reqHash = hashRequest(input);
    const existing = (await client.query('SELECT * FROM account_adjustments WHERE initiated_by = $1 AND idempotency_key = $2', [staff.id, idempotencyKey])).rows[0];
    if (existing) {
      if (existing.request_hash !== reqHash) throw conflict('idempotency_key_reuse', 'This Idempotency-Key was already used with a different request');
      return { adjustment: existing, replayed: true };
    }
    const reason = (await client.query('SELECT * FROM adjustment_reasons WHERE code = $1 AND enabled', [input.reasonCode])).rows[0];
    if (!reason) throw unprocessable('invalid_reason', 'Unknown or disabled adjustment reason');
    if (reason.direction !== input.direction) throw unprocessable('reason_direction_mismatch', `Reason ${reason.code} is a ${reason.direction} reason`);
    if (reason.counter_role === 'PROMO') {
      const s = (await client.query(`SELECT value FROM application_settings WHERE key = 'promo_credits_enabled'`)).rows[0];
      if (s?.value !== true) throw unprocessable('promo_disabled', 'Promotional credits are not enabled');
    }
    if (reason.requires_external_reference && !input.externalReference)
      throw unprocessable('external_reference_required', `Reason ${reason.code} requires an external (provider/bank) reference`);
    if (acct.status !== 'active') throw unprocessable('account_not_active', 'Account is not active');
    if (config.isProd && acct.is_test) throw forbidden('Test accounts cannot be adjusted in production');

    const amt = parseAmount(input.amount, acct.decimals);
    if (input.direction === 'debit') {
      const bal = await getBalances(client, acct.id);
      if (amt.units > bal._units.available) throw unprocessable('insufficient_funds', 'Insufficient available funds for debit adjustment');
    }
    const lim = (await client.query('SELECT auto_post_limit, dual_approval_limit FROM adjustment_limits WHERE currency = $1', [acct.currency])).rows[0];
    const auto = lim ? toUnits(lim.auto_post_limit) : 0n;
    const dual = lim ? toUnits(lim.dual_approval_limit) : 0n;
    let required;
    if (auto > 0n && amt.units <= auto && staff.permissions.has('adjustments.post_small')) required = 0;
    else required = amt.units > dual ? 2 : 1;

    const { rows } = await client.query(
      `INSERT INTO account_adjustments
         (reference, customer_account_id, direction, amount, currency, reason_code, explanation, internal_reference,
          external_reference, evidence_ref, is_test, status, approvals_required, initiated_by, idempotency_key, request_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending_approval',$12,$13,$14,$15) RETURNING *`,
      [newReference('ADJ'), acct.id, input.direction, amt.text, acct.currency, reason.code, input.explanation, input.internalReference,
       input.externalReference ?? null, input.evidenceRef ?? null, acct.is_test, required, staff.id, idempotencyKey, reqHash]);
    let adj = rows[0];
    await audit(client, { actorType: 'staff', actorId: staff.id, action: 'adjustment.requested', entityType: 'account_adjustment', entityId: adj.id, ip,
      details: { reference: adj.reference, direction: adj.direction, amount: adj.amount, currency: adj.currency, reason: adj.reason_code, approvals_required: required } });
    if (required === 0) adj = await postAdjustment(client, adj, staff.id, ip);
    return { adjustment: adj, replayed: false };
  });
}

export async function approveAdjustment({ staff, id, comment, ip }) {
  return withTx(async (client) => {
    const adj = (await client.query('SELECT * FROM account_adjustments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!adj) throw notFound('Adjustment not found');
    if (adj.status !== 'pending_approval') throw conflict('not_pending', `Adjustment is ${adj.status}`);
    if (adj.initiated_by === staff.id) throw forbidden('You cannot approve your own adjustment');
    const ins = await client.query(
      `INSERT INTO adjustment_approvals (adjustment_id, staff_id, decision, comment) VALUES ($1,$2,'approved',$3) ON CONFLICT DO NOTHING`, [id, staff.id, comment ?? null]);
    if (!ins.rowCount) throw conflict('already_decided', 'You have already reviewed this adjustment');
    const n = Number((await client.query(`SELECT count(*) FROM adjustment_approvals WHERE adjustment_id = $1 AND decision = 'approved'`, [id])).rows[0].count);
    await audit(client, { actorType: 'staff', actorId: staff.id, action: 'adjustment.approved', entityType: 'account_adjustment', entityId: id, ip, details: { approvals: n, required: adj.approvals_required } });
    if (n >= adj.approvals_required) return { adjustment: await postAdjustment(client, adj, staff.id, ip) };
    return { adjustment: adj, approvals: n };
  });
}

export async function rejectAdjustment({ staff, id, reason, ip }) {
  return withTx(async (client) => {
    const adj = (await client.query('SELECT * FROM account_adjustments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!adj) throw notFound('Adjustment not found');
    if (adj.status !== 'pending_approval') throw conflict('not_pending', `Adjustment is ${adj.status}`);
    await client.query(`INSERT INTO adjustment_approvals (adjustment_id, staff_id, decision, comment) VALUES ($1,$2,'rejected',$3) ON CONFLICT (adjustment_id, staff_id) DO UPDATE SET decision = 'rejected', comment = EXCLUDED.comment`, [id, staff.id, reason]);
    const { rows } = await client.query(
      `UPDATE account_adjustments SET status = 'rejected', rejection_reason = $2, decided_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [id, reason]);
    await audit(client, { actorType: 'staff', actorId: staff.id, action: 'adjustment.rejected', entityType: 'account_adjustment', entityId: id, ip, details: { reason } });
    return { adjustment: rows[0] };
  });
}

export async function listAdjustments({ status, limit, offset }) {
  const { rows } = await query(
    `SELECT a.*, ca.public_identifier, s.full_name AS initiated_by_name,
            (SELECT count(*) FROM adjustment_approvals x WHERE x.adjustment_id = a.id AND x.decision = 'approved')::int AS approvals
       FROM account_adjustments a JOIN customer_accounts ca ON ca.id = a.customer_account_id JOIN staff_users s ON s.id = a.initiated_by
      WHERE ($1::text IS NULL OR a.status = $1) ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`, [status ?? null, limit, offset]);
  return rows;
}
export async function getAdjustment(id) {
  const adj = (await query('SELECT * FROM account_adjustments WHERE id = $1', [id])).rows[0];
  if (!adj) throw notFound('Adjustment not found');
  const approvals = (await query(
    `SELECT x.decision, x.comment, x.created_at, s.full_name FROM adjustment_approvals x JOIN staff_users s ON s.id = x.staff_id WHERE adjustment_id = $1 ORDER BY x.created_at`, [id])).rows;
  return { ...adj, approvals };
}
export { DB_SCALE };
