import crypto from 'node:crypto';
import { AppError, conflict, notFound, unprocessable } from '../../utils/errors.js';
import { DB_SCALE, formatDb, fromUnits, toUnits } from '../../utils/money.js';

export const newReference = (prefix = 'ZB') => `${prefix}-${crypto.randomBytes(7).toString('hex').toUpperCase()}`;
export const hashRequest = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

export async function getCurrency(client, code) {
  const { rows } = await client.query('SELECT code, decimals, enabled FROM currencies WHERE code = $1', [code]);
  if (!rows[0]) throw unprocessable('unknown_currency', `Unknown currency ${code}`);
  if (!rows[0].enabled) throw unprocessable('currency_disabled', `Currency ${code} is not enabled`);
  return rows[0];
}

const SYSTEM_ROLES = {
  SETTLEMENT:  { type: 'asset',   name: 'Settlement funds' },
  REFUNDS:     { type: 'expense', name: 'Refunds expense' },
  CORRECTIONS: { type: 'asset',   name: 'Corrections suspense' },
  PROMO:       { type: 'expense', name: 'Promotional credits expense' },
  FEES:        { type: 'revenue', name: 'Fee revenue' },
};

/** Get-or-create the per-currency system ledger account for a role. */
export async function ensureSystemAccount(client, role, currency) {
  const spec = SYSTEM_ROLES[role];
  if (!spec) throw new Error(`Unknown system role ${role}`);
  const code = `SYS-${role}-${currency}`;
  const { rows } = await client.query(
    `INSERT INTO ledger_accounts (code, name, type, currency) VALUES ($1,$2,$3,$4)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    [code, `${spec.name} (${currency})`, spec.type, currency]);
  return rows[0].id;
}

/** Lock customer accounts in a deterministic order (prevents deadlocks) and return them keyed by id. */
export async function lockCustomerAccounts(client, ids) {
  const unique = [...new Set(ids)].sort();
  const { rows } = await client.query(
    `SELECT a.*, c.decimals FROM customer_accounts a JOIN currencies c ON c.code = a.currency
      WHERE a.id = ANY($1::uuid[]) ORDER BY a.id FOR UPDATE OF a`, [unique]);
  if (rows.length !== unique.length) throw notFound('Account not found');
  return Object.fromEntries(rows.map(r => [r.id, r]));
}

/** Balances derived from the ledger. Call after lockCustomerAccounts for check-then-post flows. */
export async function getBalances(client, customerAccountId) {
  const { rows } = await client.query(
    `SELECT a.currency, c.decimals,
        COALESCE((SELECT SUM(CASE p.direction WHEN 'C' THEN p.amount ELSE -p.amount END)
                    FROM ledger_postings p WHERE p.ledger_account_id = a.ledger_account_id), 0) AS ledger,
        COALESCE((SELECT SUM(h.amount) FROM account_holds h
                   WHERE h.customer_account_id = a.id AND h.status = 'active'), 0) AS held
       FROM customer_accounts a JOIN currencies c ON c.code = a.currency WHERE a.id = $1`, [customerAccountId]);
  if (!rows[0]) throw notFound('Account not found');
  const { currency, decimals, ledger, held } = rows[0];
  const l = toUnits(ledger), h = toUnits(held);
  return {
    currency,
    ledger_balance: fromUnits(l, DB_SCALE, decimals),
    pending_holds: fromUnits(h, DB_SCALE, decimals),
    available_balance: fromUnits(l - h, DB_SCALE, decimals),
    _units: { ledger: l, held: h, available: l - h },
  };
}
export const publicBalances = ({ _units, ...rest }) => rest;

/**
 * Post one balanced journal entry. lines: [{ledgerAccountId, direction:'D'|'C', amount:'12.34'}]
 * Double-checked in JS (BigInt) and by the deferred DB trigger at COMMIT.
 * Customer accounts debited by the entry may not end below zero (safety net; callers also check available funds under lock).
 */
export async function postJournal(client, { transactionId, description, currency, lines }) {
  let d = 0n, c = 0n;
  for (const l of lines) {
    const u = toUnits(l.amount);
    if (u <= 0n) throw unprocessable('invalid_amount', 'Posting amounts must be positive');
    if (l.direction === 'D') d += u; else if (l.direction === 'C') c += u; else throw new Error('bad direction');
  }
  if (lines.length < 2 || d !== c) throw new AppError(500, 'unbalanced_entry', 'Journal entry is not balanced');

  const je = await client.query(
    `INSERT INTO journal_entries (financial_transaction_id, description, currency) VALUES ($1,$2,$3) RETURNING id`,
    [transactionId, description, currency]);
  const jeId = je.rows[0].id;
  const values = [], params = [];
  lines.forEach((l, i) => {
    params.push(jeId, l.ledgerAccountId, l.direction, l.amount, currency);
    values.push(`($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`);
  });
  await client.query(
    `INSERT INTO ledger_postings (journal_entry_id, ledger_account_id, direction, amount, currency) VALUES ${values.join(',')}`, params);

  const debitedCustomer = lines.filter(l => l.direction === 'D').map(l => l.ledgerAccountId);
  if (debitedCustomer.length) {
    const neg = await client.query(
      `SELECT la.code FROM ledger_accounts la
        WHERE la.id = ANY($1::uuid[]) AND la.is_customer
          AND (SELECT COALESCE(SUM(CASE p.direction WHEN 'C' THEN p.amount ELSE -p.amount END),0)
                 FROM ledger_postings p WHERE p.ledger_account_id = la.id) < 0`, [debitedCustomer]);
    if (neg.rowCount) throw unprocessable('insufficient_funds', 'Posting would overdraw a customer account');
  }
  return jeId;
}

export async function createFinancialTransaction(client, t) {
  const { rows } = await client.query(
    `INSERT INTO financial_transactions
       (reference, type, status, currency, amount, description, initiated_by_user_id, initiated_by_staff_id,
        from_account_id, to_account_id, reverses_transaction_id, is_test, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [newReference(), t.type, t.status ?? 'completed', t.currency, t.amount, t.description, t.userId ?? null, t.staffId ?? null,
     t.fromAccountId ?? null, t.toAccountId ?? null, t.reversesId ?? null, t.isTest ?? false, JSON.stringify(t.metadata ?? {})]);
  return rows[0];
}

// ---------- Idempotency ----------
export async function claimIdempotencyKey(client, scope, key, requestHash) {
  const ins = await client.query(
    `INSERT INTO transaction_idempotency_keys (scope, key, request_hash) VALUES ($1,$2,$3)
     ON CONFLICT (scope, key) DO NOTHING`, [scope, key, requestHash]);
  if (ins.rowCount === 1) return { claimed: true };
  const { rows } = await client.query(
    'SELECT request_hash, financial_transaction_id FROM transaction_idempotency_keys WHERE scope = $1 AND key = $2', [scope, key]);
  if (rows[0].request_hash !== requestHash)
    throw conflict('idempotency_key_reuse', 'This Idempotency-Key was already used with a different request');
  return { claimed: false, transactionId: rows[0].financial_transaction_id };
}
export const attachIdempotency = (client, scope, key, txId) =>
  client.query('UPDATE transaction_idempotency_keys SET financial_transaction_id = $3 WHERE scope = $1 AND key = $2', [scope, key, txId]);

// ---------- Holds ----------
export async function placeHold(client, { customerAccountId, amount, reason }) {
  const accts = await lockCustomerAccounts(client, [customerAccountId]);
  const acct = accts[customerAccountId];
  if (acct.status !== 'active') throw unprocessable('account_not_active', 'Account is not active');
  const bal = await getBalances(client, customerAccountId);
  if (toUnits(amount) > bal._units.available) throw unprocessable('insufficient_funds', 'Insufficient available funds for hold');
  const { rows } = await client.query(
    `INSERT INTO account_holds (customer_account_id, amount, reason) VALUES ($1,$2,$3) RETURNING *`,
    [customerAccountId, amount, reason]);
  return rows[0];
}
export async function releaseHold(client, holdId) {
  const { rows } = await client.query(
    `UPDATE account_holds SET status = 'released', released_at = now() WHERE id = $1 AND status = 'active' RETURNING *`, [holdId]);
  if (!rows[0]) throw conflict('hold_not_active', 'Hold is not active');
  return rows[0];
}

// ---------- Reversal (compensating entries; originals are never altered) ----------
export async function reverseTransaction(client, { transactionId, reason, staffId = null, userId = null }) {
  const orig = (await client.query('SELECT * FROM financial_transactions WHERE id = $1 FOR UPDATE', [transactionId])).rows[0];
  if (!orig) throw notFound('Transaction not found');
  if (orig.status !== 'completed') throw conflict('not_reversible', `Transaction is ${orig.status}`);
  const accountIds = [orig.from_account_id, orig.to_account_id].filter(Boolean);
  if (accountIds.length) await lockCustomerAccounts(client, accountIds);

  const rev = await createFinancialTransaction(client, {
    type: 'reversal', currency: orig.currency, amount: orig.amount, description: `Reversal of ${orig.reference}: ${reason}`,
    staffId, userId, fromAccountId: orig.to_account_id, toAccountId: orig.from_account_id, reversesId: orig.id,
    isTest: orig.is_test, metadata: { reason },
  });
  const entries = (await client.query('SELECT id, description FROM journal_entries WHERE financial_transaction_id = $1', [orig.id])).rows;
  for (const e of entries) {
    const postings = (await client.query('SELECT ledger_account_id, direction, amount FROM ledger_postings WHERE journal_entry_id = $1', [e.id])).rows;
    await postJournal(client, {
      transactionId: rev.id, description: `Reversal: ${e.description}`, currency: orig.currency,
      lines: postings.map(p => ({ ledgerAccountId: p.ledger_account_id, direction: p.direction === 'D' ? 'C' : 'D', amount: p.amount })),
    });
  }
  await client.query(`UPDATE financial_transactions SET status = 'reversed', updated_at = now() WHERE id = $1`, [orig.id]);
  return rev;
}

export { formatDb };
