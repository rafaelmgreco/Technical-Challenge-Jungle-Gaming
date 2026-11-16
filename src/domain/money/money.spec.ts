import { describe, expect, it } from 'bun:test';
import {
  InvalidMoneyError,
  Money,
  MoneyCurrencyMismatchError,
} from './money.js';

describe('Money', () => {
  it('parses and serializes exact two-decimal amounts', () => {
    const money = Money.from({ amount: '25.07', currency: 'BRL' });

    expect(money.toString()).toBe('25.07');
    expect(money.toJSON()).toEqual({ amount: '25.07', currency: 'BRL' });
  });

  it('normalizes leading zeroes while preserving two decimal places', () => {
    expect(Money.from({ amount: '00025.00', currency: 'BRL' }).toString()).toBe(
      '25.00',
    );
  });

  it('creates zero for a valid currency', () => {
    const zero = Money.zero('BRL');

    expect(zero.isZero()).toBe(true);
    expect(zero.toString()).toBe('0.00');
  });

  it('adds, subtracts, and negates without mutating existing values', () => {
    const balance = Money.from({ amount: '100.00', currency: 'BRL' });
    const movement = Money.from({ amount: '25.50', currency: 'BRL' });

    expect(balance.subtract(movement).toString()).toBe('74.50');
    expect(movement.negate().toString()).toBe('-25.50');
    expect(balance.add(movement).toString()).toBe('125.50');
    expect(balance.toString()).toBe('100.00');
  });

  it('compares values with the same currency', () => {
    const lower = Money.from({ amount: '10.00', currency: 'BRL' });
    const higher = Money.from({ amount: '10.01', currency: 'BRL' });

    expect(lower.isLessThan(higher)).toBe(true);
    expect(lower.equals(higher)).toBe(false);
    expect(higher.isPositive()).toBe(true);
    expect(higher.negate().isNegative()).toBe(true);
  });

  it('rejects invalid or unsupported-scale decimal inputs', () => {
    for (const amount of ['', '25', '25.', '25.001', '-1.00', 'NaN', 'Infinity', '1e2']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('rejects malformed currency codes', () => {
    for (const currency of ['brl', 'BR', 'BRL1', '', 'ZZZ']) {
      expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
    }
  });

  it('rejects arithmetic and ordering across currencies', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(MoneyCurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(MoneyCurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(MoneyCurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  it('rejects values outside the PostgreSQL BIGINT minor-unit range', () => {
    expect(() =>
      Money.from({
        amount: '92233720368547758.08',
        currency: 'BRL',
      }),
    ).toThrow(InvalidMoneyError);
  });
});
