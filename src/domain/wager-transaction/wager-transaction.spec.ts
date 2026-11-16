import { describe, expect, it } from 'bun:test';
import { Money } from '../money/money.js';
import {
  InvalidWagerTransactionError,
  InvalidWagerTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from './wager-transaction.js';

const createdAt = new Date('2026-01-01T00:00:00.000Z');
const processedAt = new Date('2026-01-02T00:00:00.000Z');

function createTransaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: 'internal-1',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-a:external-1',
    payloadHash: 'abc123',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt,
    ...overrides,
  });
}

describe('WagerTransaction', () => {
  it('creates a pending transaction with immutable identity and payload data', () => {
    const transaction = createTransaction();

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.idempotencyKey).toBe('provider-a:external-1');
    expect(transaction.matchesPayload('abc123')).toBe(true);
    expect(transaction.matchesPayload('different')).toBe(false);
    expect(transaction.createdAt).toEqual(createdAt);
  });

  it('rejects non-positive transaction amounts', () => {
    expect(() =>
      createTransaction({ money: Money.zero('BRL') }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      createTransaction({ money: Money.fromMinorUnits(-1n, 'BRL') }),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('requires an external reference for REFUND and ROLLBACK', () => {
    expect(() =>
      createTransaction({ kind: WagerTransactionKind.Refund }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      createTransaction({ kind: WagerTransactionKind.Rollback }),
    ).toThrow(InvalidWagerTransactionError);

    const refund = createTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });
    expect(refund.requiresReference()).toBe(true);
  });

  it('allows WIN to carry an optional reference', () => {
    const win = createTransaction({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'bet-1',
    });

    expect(win.requiresReference()).toBe(false);
    expect(win.referenceExternalTransactionId).toBe('bet-1');
  });

  it('moves a referenced transaction into PENDING_REFERENCE', () => {
    const refund = createTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });

    refund.markPendingReference();

    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
  });

  it('does not allow PENDING_REFERENCE without a reference', () => {
    const bet = createTransaction();

    expect(() => bet.markPendingReference()).toThrow(
      InvalidWagerTransactionStateError,
    );
  });

  it('processes an unreferenced transaction', () => {
    const bet = createTransaction();

    bet.markProcessed(undefined, processedAt);

    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.processedAt).toEqual(processedAt);
    expect(bet.referenceTransactionId).toBeUndefined();
    expect(bet.isTerminal()).toBe(true);
  });

  it('requires a resolved internal reference before processing a referenced transaction', () => {
    const refund = createTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });
    refund.markPendingReference();

    expect(() => refund.markProcessed(undefined, processedAt)).toThrow(
      InvalidWagerTransactionError,
    );

    refund.markProcessed('internal-bet-1', processedAt);
    expect(refund.referenceTransactionId).toBe('internal-bet-1');
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
  });

  it('rejects with a stable machine-readable failure code', () => {
    const bet = createTransaction();

    bet.reject('INSUFFICIENT_FUNDS');

    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
    expect(bet.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(bet.isTerminal()).toBe(true);
  });

  it('fails permanently with a stable machine-readable failure code', () => {
    const bet = createTransaction();

    bet.fail('PERMANENT_INFRASTRUCTURE_ERROR');

    expect(bet.status).toBe(WagerTransactionStatus.Failed);
    expect(bet.failureCode).toBe('PERMANENT_INFRASTRUCTURE_ERROR');
    expect(bet.isTerminal()).toBe(true);
  });

  it('rejects malformed failure codes', () => {
    expect(() => createTransaction().reject('insufficient funds')).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('prevents every transition from a terminal status', () => {
    const processed = createTransaction();
    processed.markProcessed(undefined, processedAt);

    expect(() => processed.reject('INVALID_OPERATION')).toThrow(
      InvalidWagerTransactionStateError,
    );
    expect(() => processed.fail('PERMANENT_INFRASTRUCTURE_ERROR')).toThrow(
      InvalidWagerTransactionStateError,
    );
    expect(() => processed.markPendingReference()).toThrow(
      InvalidWagerTransactionStateError,
    );
    expect(() => processed.markProcessed(undefined, processedAt)).toThrow(
      InvalidWagerTransactionStateError,
    );
  });

  it('marks LOSS as not affecting the balance', () => {
    const loss = createTransaction({ kind: WagerTransactionKind.Loss });

    expect(loss.affectsBalance()).toBe(false);
    expect(createTransaction().affectsBalance()).toBe(true);
  });

  it('rehydrates persisted state without replaying transitions', () => {
    const processed = WagerTransaction.rehydrate({
      id: 'internal-1',
      providerId: 'provider-a',
      externalTransactionId: 'external-1',
      idempotencyKey: 'provider-a:external-1',
      payloadHash: 'abc123',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      createdAt,
      status: WagerTransactionStatus.Processed,
      referenceExternalTransactionId: 'bet-1',
      referenceTransactionId: 'internal-bet-1',
      processedAt,
    });

    expect(processed.status).toBe(WagerTransactionStatus.Processed);
    expect(processed.referenceTransactionId).toBe('internal-bet-1');
    expect(processed.processedAt).toEqual(processedAt);
    expect(() => processed.markPendingReference()).toThrow(
      InvalidWagerTransactionStateError,
    );
  });
});
