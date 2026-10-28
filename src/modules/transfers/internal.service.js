import { query, withTx } from '../../database/pool.js';
import { audit, notify } from '../../services/audit.js';
import { notFound, unprocessable } from '../../utils/errors.js';
import { parseAmount } from '../../utils/money.js';
import {
  attachIdempotency, claimIdempotencyKey, createFinancialTransaction, getBalances, hashRequest,
  lockCustomerAccounts, postJournal,
} from '../ledger/ledger.service.js';

const mask = (n) => n.split(/\s+/).map(p => p[0] + '*'.repeat(Math.max(2, p.length - 1))).join(' ');

export async function lookupRecipient(identifier) {
  const { rows } = await query(
    `SELECT a.public_identifier, a.currency, p.full_name FROM customer_accounts a
       JOIN user_profiles p ON p.user_id = a.user_id WHERE a.public_identifier = $1 AND a.status = 'active'`, [identifier]);
  if (!rows[0]) throw notFound('Recipient not found');
  return { account: rows[0].public_identifier, currency: rows[0].currency, name: mask(rows[0].full_name) };
}

/** Atomic same-currency transfer between two ZenvoBank accounts. PIN verification happens in the route before this call. */
export async function internalTransfer({ user, sourceAccountId, recipientIdentifier, amount, note, idempotencyKey, ip }) {
  return withTx(async (client) => {
    const scope = `transfer:${user.id}`;
    const claim = await claimIdempotencyKey(client, scope, idempotencyKey,
      hashRequest({ sourceAccountId, recipientIdentifier, amount, note: note ?? null }));
    if (!claim.claimed) {
      const tx = (await client.query('SELECT reference, status, amount, currency, created_at FROM financial_transactions WHERE id = $1', [claim.transactionId])).rows[0];
      return { transaction: tx, replayed: true };
    }

    const rec = (await client.query('SELECT id FROM customer_accounts WHERE public_identifier = $1', [recipientIdentifier])).rows[0];
    if (!rec) throw notFound('Recipient not found');
    const locked = await lockCustomerAccounts(client, [sourceAccountId, rec.id]); // one deterministic lock order
    const src = locked[sourceAccountId], dst = locked[rec.id];
    if (src.user_id !== user.id) throw notFound('Account not found');
    if (src.status !== 'active') throw unprocessable('account_not_active', 'Your account is not active');
    if (dst.status !== 'active') throw unprocessable('recipient_not_active', 'Recipient account cannot receive funds');
    if (src.id === dst.id) throw unprocessable('same_account', 'Cannot transfer to the same account');
    if (src.currency !== dst.currency)
      throw unprocessable('cross_currency_unsupported', 'Cross-currency transfers require the approved conversion workflow, which is not available yet');
    if (src.is_test !== dst.is_test) throw unprocessable('test_real_mismatch', 'Test and live accounts cannot transact with each other');

    const amt = parseAmount(amount, src.decimals);
    const bal = await getBalances(client, src.id);
    if (amt.units > bal._units.available) throw unprocessable('insufficient_funds', 'Insufficient available balance');

    const tx = await createFinancialTransaction(client, {
      type: 'internal_transfer', currency: src.currency, amount: amt.text, description: note?.trim() || 'Transfer to ZenvoBank account',
      userId: user.id, fromAccountId: src.id, toAccountId: dst.id, isTest: src.is_test,
    });
    await postJournal(client, {
      transactionId: tx.id, description: `Internal transfer ${tx.reference}`, currency: src.currency,
      lines: [{ ledgerAccountId: src.ledger_account_id, direction: 'D', amount: amt.text },
              { ledgerAccountId: dst.ledger_account_id, direction: 'C', amount: amt.text }],
    });
    await attachIdempotency(client, scope, idempotencyKey, tx.id);
    await notify(client, src.user_id, 'transfer', 'Transfer sent', `You sent ${amt.text} ${src.currency}. Ref ${tx.reference}.`);
    await notify(client, dst.user_id, 'transfer', 'Money received', `You received ${amt.text} ${dst.currency}. Ref ${tx.reference}.`);
    await audit(client, { actorType: 'customer', actorId: user.id, action: 'transfer.internal.completed', entityType: 'financial_transaction', entityId: tx.id, ip });
    return { transaction: { reference: tx.reference, status: tx.status, amount: amt.text, currency: tx.currency, created_at: tx.created_at }, replayed: false };
  });
}
