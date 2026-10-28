// Fixed-precision money helpers. Amounts are decimal strings; arithmetic uses BigInt. Never Number.
import { unprocessable } from './errors.js';

export const DB_SCALE = 8;

/** Parse a decimal string into BigInt units at `scale` decimals. Throws if it has more precision than `scale`. */
export function toUnits(value, scale = DB_SCALE) {
  const s = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw unprocessable('invalid_amount', `Invalid amount: ${s}`);
  const neg = s.startsWith('-');
  const [intPart, frac = ''] = s.replace('-', '').split('.');
  const trimmed = frac.replace(/0+$/, '');
  if (trimmed.length > scale) throw unprocessable('amount_precision', `Amount has more than ${scale} decimal places`);
  const units = BigInt(intPart + trimmed.padEnd(scale, '0'));
  return neg ? -units : units;
}

/** Format BigInt units at `scale` decimals into a string with exactly `decimals` places. */
export function fromUnits(units, scale = DB_SCALE, decimals = scale) {
  const neg = units < 0n;
  let abs = neg ? -units : units;
  if (decimals < scale) {
    const drop = 10n ** BigInt(scale - decimals);
    if (abs % drop !== 0n) throw new Error('Refusing to round a monetary value');
    abs /= drop;
    scale = decimals;
  }
  const str = abs.toString().padStart(scale + 1, '0');
  const intPart = str.slice(0, str.length - scale);
  const frac = scale ? '.' + str.slice(str.length - scale) : '';
  return (neg ? '-' : '') + intPart + frac;
}

/** Validate a client-supplied amount for a currency: positive, within the currency's decimal precision. */
export function parseAmount(value, decimals) {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw unprocessable('invalid_amount', 'Amount must be a positive decimal string');
  const frac = (s.split('.')[1] || '').replace(/0+$/, '');
  if (frac.length > decimals) throw unprocessable('amount_precision', `This currency allows at most ${decimals} decimal places`);
  const units = toUnits(s);
  if (units <= 0n) throw unprocessable('invalid_amount', 'Amount must be greater than zero');
  return { units, text: fromUnits(units, DB_SCALE, decimals) };
}

/** Normalise a NUMERIC text from Postgres to the currency's display precision. */
export function formatDb(text, decimals) {
  return fromUnits(toUnits(text), DB_SCALE, decimals);
}
