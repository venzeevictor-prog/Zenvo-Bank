import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDb, fromUnits, parseAmount, toUnits } from '../../src/utils/money.js';

test('decimal arithmetic is exact (no floating point drift)', () => {
  assert.equal(fromUnits(toUnits('0.1') + toUnits('0.2')), '0.30000000');
  assert.equal(fromUnits(toUnits('0.1') + toUnits('0.2'), 8, 2), '0.30');
});
test('parseAmount enforces currency precision', () => {
  assert.equal(parseAmount('10.50', 2).text, '10.50');
  assert.equal(parseAmount('10.5', 2).text, '10.50');
  assert.throws(() => parseAmount('10.505', 2), /decimal places/);
  assert.equal(parseAmount('1500', 0).text, '1500');
  assert.throws(() => parseAmount('1500.5', 0), /decimal places/);
});
test('parseAmount rejects zero, negatives, exponents and junk', () => {
  for (const bad of ['0', '0.00', '-5', '1e3', 'abc', '', '1,000', ' ', '5.']) assert.throws(() => parseAmount(bad, 2), undefined, bad);
});
test('formatDb normalises NUMERIC text and refuses to round', () => {
  assert.equal(formatDb('100.00000000', 2), '100.00');
  assert.throws(() => formatDb('100.12345678', 2), /round/);
});
test('large values keep precision', () => {
  assert.equal(fromUnits(toUnits('99999999999999999999.99999999')), '99999999999999999999.99999999');
});
