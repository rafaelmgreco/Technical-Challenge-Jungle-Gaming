import { describe, expect, it } from 'bun:test';
import { Money } from '../money/money.js';
import { LedgerDirection } from '../ledger/ledger-entry.js';
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
const retryAt = new Date('2026-01-02T00:00:01.000Z');

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

    refund.markPendingReference(retryAt);

    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.referenceAttemptCount).toBe(1);
    expect(refund.referenceNextAttemptAt).toEqual(retryAt);
    expect(refund.recordReferenceRetry(processedAt)).toBe(2);
    expect(refund.referenceNextAttemptAt).toEqual(processedAt);
  });

  it('does not allow PENDING_REFERENCE without a reference', () => {
    const bet = createTransaction();

    expect(() => bet.markPendingReference(retryAt)).toThrow(
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
    refund.markPendingReference(retryAt);

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
    expect(() => processed.markPendingReference(retryAt)).toThrow(
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

  it('maps BET, WIN, LOSS, and OPENING to their ledger effects', () => {
    expect(createTransaction().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(
      createTransaction({ kind: WagerTransactionKind.Win }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    expect(
      createTransaction({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor(),
    ).toBeUndefined();
    expect(
      createTransaction({ kind: WagerTransactionKind.Opening }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  it('credits a REFUND only against a processed BET in the same context and amount', () => {
    const referenceBet = createTransaction({
      id: 'internal-bet-1',
      externalTransactionId: 'bet-1',
    });
    referenceBet.markProcessed(undefined, processedAt);
    const refund = createTransaction({
      kind: WagerTransactionKind.Refund,
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'bet-1',
    });

    expect(refund.ledgerDirectionFor(referenceBet)).toBe(
      LedgerDirection.Credit,
    );
  });

  it('allows WIN to reference a processed BET with a different amount', () => {
    const referenceBet = createTransaction({
      id: 'internal-bet-1',
      externalTransactionId: 'bet-1',
    });
    referenceBet.markProcessed(undefined, processedAt);
    const win = createTransaction({
      kind: WagerTransactionKind.Win,
      externalTransactionId: 'win-1',
      referenceExternalTransactionId: 'bet-1',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    expect(win.ledgerDirectionFor(referenceBet)).toBe(LedgerDirection.Credit);
  });

  it('inverts ledger direction for ROLLBACK of BET, WIN, or REFUND', () => {
    const bet = createTransaction({
      id: 'internal-bet-1',
      externalTransactionId: 'bet-1',
    });
    bet.markProcessed(undefined, processedAt);
    const rollbackBet = createTransaction({
      kind: WagerTransactionKind.Rollback,
      externalTransactionId: 'rollback-bet',
      referenceExternalTransactionId: 'bet-1',
    });
    expect(rollbackBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const win = createTransaction({
      id: 'internal-win-1',
      externalTransactionId: 'win-1',
      kind: WagerTransactionKind.Win,
    });
    win.markProcessed(undefined, processedAt);
    const rollbackWin = createTransaction({
      kind: WagerTransactionKind.Rollback,
      externalTransactionId: 'rollback-win',
      referenceExternalTransactionId: 'win-1',
    });
    expect(rollbackWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);

    const refund = createTransaction({
      id: 'internal-refund-1',
      externalTransactionId: 'refund-1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });
    refund.markProcessed('internal-bet-1', processedAt);
    const rollbackRefund = createTransaction({
      kind: WagerTransactionKind.Rollback,
      externalTransactionId: 'rollback-refund',
      referenceExternalTransactionId: 'refund-1',
    });
    expect(rollbackRefund.ledgerDirectionFor(refund)).toBe(
      LedgerDirection.Debit,
    );
  });

  it('rejects references that are missing, unprocessed, of the wrong kind, or mismatched', () => {
    const refund = createTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });
    expect(() => refund.ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );

    const pendingBet = createTransaction({ externalTransactionId: 'bet-1' });
    expect(() => refund.ledgerDirectionFor(pendingBet)).toThrow(
      InvalidWagerTransactionError,
    );

    const processedWin = createTransaction({
      externalTransactionId: 'bet-1',
      kind: WagerTransactionKind.Win,
    });
    processedWin.markProcessed(undefined, processedAt);
    expect(() => refund.ledgerDirectionFor(processedWin)).toThrow(
      InvalidWagerTransactionError,
    );

    const processedBet = createTransaction({
      externalTransactionId: 'bet-1',
      roundId: 'different-round',
    });
    processedBet.markProcessed(undefined, processedAt);
    expect(() => refund.ledgerDirectionFor(processedBet)).toThrow(
      InvalidWagerTransactionError,
    );
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
    expect(() => processed.markPendingReference(retryAt)).toThrow(
      InvalidWagerTransactionStateError,
    );
  });
});
