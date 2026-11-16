import { describe, expect, it } from 'bun:test';
import { Money, MoneyCurrencyMismatchError } from '../money/money.js';
import {
  InsufficientWalletFundsError,
  InvalidWalletError,
  InvalidWalletMovementError,
  Wallet,
} from './wallet.js';

const openedAt = new Date('2026-01-01T00:00:00.000Z');
const movedAt = new Date('2026-01-02T00:00:00.000Z');

function openWallet(initialBalance = '100.00'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
    openedAt,
  });
}

describe('Wallet', () => {
  it('opens with its initial balance, version 1, and matching timestamps', () => {
    const wallet = openWallet();

    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  it('allows an opening balance of zero', () => {
    const wallet = openWallet('0.00');

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  it('rejects an empty wallet or player identifier', () => {
    expect(() =>
      Wallet.open({
        id: ' ',
        playerId: 'player-1',
        initialBalance: Money.zero('BRL'),
        openedAt,
      }),
    ).toThrow(InvalidWalletError);

    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: '',
        initialBalance: Money.zero('BRL'),
        openedAt,
      }),
    ).toThrow(InvalidWalletError);
  });

  it('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.fromMinorUnits(-1n, 'BRL'),
        openedAt,
      }),
    ).toThrow(InvalidWalletError);
  });

  it('debits the balance and returns the movement snapshot', () => {
    const wallet = openWallet();
    const change = wallet.debit(
      Money.from({ amount: '80.00', currency: 'BRL' }),
      movedAt,
    );

    expect(change.direction).toBe('DEBIT');
    expect(change.balanceBefore.toString()).toBe('100.00');
    expect(change.balanceAfter.toString()).toBe('20.00');
    expect(change.walletVersion).toBe(2);
    expect(change.occurredAt).toEqual(movedAt);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(movedAt);
  });

  it('credits the balance and increments the version', () => {
    const wallet = openWallet('0.00');

    wallet.credit(Money.from({ amount: '12.34', currency: 'BRL' }), movedAt);

    expect(wallet.balance.toString()).toBe('12.34');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(movedAt);
  });

  it('rejects a debit that would make the balance negative without changing state', () => {
    const wallet = openWallet('20.00');

    expect(() =>
      wallet.debit(Money.from({ amount: '20.01', currency: 'BRL' }), movedAt),
    ).toThrow(InsufficientWalletFundsError);

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  it('rejects zero and negative movements', () => {
    const wallet = openWallet();

    expect(() =>
      wallet.debit(Money.zero('BRL'), movedAt),
    ).toThrow(InvalidWalletMovementError);
    expect(() =>
      wallet.credit(Money.fromMinorUnits(-1n, 'BRL'), movedAt),
    ).toThrow(InvalidWalletMovementError);

    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects a movement in a different currency', () => {
    const wallet = openWallet();

    expect(() =>
      wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }), movedAt),
    ).toThrow(MoneyCurrencyMismatchError);

    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rehydrates a persisted version without replaying movements', () => {
    const updatedAt = new Date('2026-01-03T00:00:00.000Z');
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: { amount: '75.00', currency: 'BRL' },
      version: 7,
      createdAt: openedAt,
      updatedAt,
    });

    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });

  it('does not expose mutable internal dates', () => {
    const wallet = openWallet();
    const retrievedDate = wallet.createdAt;
    retrievedDate.setFullYear(1999);

    expect(wallet.createdAt).toEqual(openedAt);
  });
});
