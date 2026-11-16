import { describe, expect, it } from 'bun:test';
import { Money, MoneyCurrencyMismatchError } from '../money/money.js';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  oppositeLedgerDirection,
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from './ledger-entry.js';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

function createLedgerEntry(
  overrides: Partial<CreateLedgerEntryProps> = {},
): WalletLedgerEntry {
  return WalletLedgerEntry.create({
    id: 'ledger-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: LedgerDirection.Debit,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
    balanceAfter: Money.from({ amount: '75.00', currency: 'BRL' }),
    createdAt,
    ...overrides,
  });
}

describe('WalletLedgerEntry', () => {
  it('creates a balanced debit entry', () => {
    const entry = createLedgerEntry();

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.money.toString()).toBe('25.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('creates a balanced credit entry', () => {
    const entry = createLedgerEntry({
      direction: LedgerDirection.Credit,
      balanceBefore: Money.from({ amount: '75.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects a balanceAfter that does not match the movement', () => {
    expect(() =>
      createLedgerEntry({
        balanceAfter: Money.from({ amount: '74.99', currency: 'BRL' }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects a debit that would make the balance negative', () => {
    expect(() =>
      createLedgerEntry({
        money: Money.from({ amount: '100.01', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.fromMinorUnits(-1n, 'BRL'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects zero and negative movement values', () => {
    expect(() =>
      createLedgerEntry({ money: Money.zero('BRL') }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      createLedgerEntry({ money: Money.fromMinorUnits(-1n, 'BRL') }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects entries whose amounts use different currencies', () => {
    expect(() =>
      createLedgerEntry({
        balanceBefore: Money.from({ amount: '100.00', currency: 'USD' }),
      }),
    ).toThrow(MoneyCurrencyMismatchError);
  });

  it('rehydrates persisted entries so reconciliation can detect imbalance', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '74.99', currency: 'BRL' },
      createdAt,
    });

    expect(entry.isBalanced()).toBe(false);
  });

  it('does not expose its mutable creation date', () => {
    const entry = createLedgerEntry();
    const retrievedDate = entry.createdAt;
    retrievedDate.setFullYear(1999);

    expect(entry.createdAt).toEqual(createdAt);
  });

  it('returns the opposite direction for a reversal', () => {
    expect(oppositeLedgerDirection(LedgerDirection.Debit)).toBe(
      LedgerDirection.Credit,
    );
    expect(oppositeLedgerDirection(LedgerDirection.Credit)).toBe(
      LedgerDirection.Debit,
    );
  });
});
