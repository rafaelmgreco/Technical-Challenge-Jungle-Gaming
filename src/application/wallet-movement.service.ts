import { Inject, Injectable } from '@nestjs/common';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger/ledger-entry.js';
import type { WalletBalanceChange } from '../domain/wallet/wallet.js';
import { InsufficientWalletFundsError } from '../domain/wallet/wallet.js';
import { Money } from '../domain/money/money.js';
import {
  InvalidWagerTransactionError,
  InvalidWagerTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction/wager-transaction.js';
import { WALLET_UNIT_OF_WORK, type WalletUnitOfWork } from './ports/wallet-unit-of-work.js';
import type { IntegrationEventOutboxRepository } from './ports/integration-event-outbox.repository.js';
import type { WagerTransactionRepository } from './ports/wager-transaction.repository.js';

const MAX_REFERENCE_ATTEMPTS = 5;
const REFERENCE_RETRY_BASE_DELAY_MS = 1_000;
const REFERENCE_RETRY_MAX_DELAY_MS = 60_000;

function referenceRetryAt(at: Date, attemptCount: number): Date {
  const delay = Math.min(
    REFERENCE_RETRY_MAX_DELAY_MS,
    REFERENCE_RETRY_BASE_DELAY_MS * 2 ** (attemptCount - 1),
  );
  return new Date(at.getTime() + delay);
}

async function persistRejection(
  transactions: WagerTransactionRepository,
  outbox: IntegrationEventOutboxRepository,
  transaction: WagerTransaction,
  failureCode: string,
  occurredAt: Date,
): Promise<{ failure: InvalidReferencedTransactionError }> {
  transaction.reject(failureCode);
  await transactions.save(transaction);
  await outbox.save({
    id: crypto.randomUUID(),
    aggregateId: transaction.id,
    eventType: 'WagerTransactionRejected',
    version: 1,
    correlationId: transaction.idempotencyKey,
    causationId: transaction.id,
    occurredAt,
    data: {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      kind: transaction.kind,
      failureCode,
    },
  });
  return { failure: new InvalidReferencedTransactionError(transaction.id, failureCode) };
}

async function enqueuePendingReferenceEvent(
  outbox: IntegrationEventOutboxRepository,
  transaction: WagerTransaction,
  occurredAt: Date,
): Promise<void> {
  await outbox.save({
    id: crypto.randomUUID(),
    aggregateId: transaction.id,
    eventType: 'WagerTransactionPendingReference',
    version: 1,
    correlationId: transaction.idempotencyKey,
    causationId: transaction.id,
    occurredAt,
    data: {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      walletId: transaction.walletId,
      kind: transaction.kind,
    },
  });
}

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} was not found`);
    this.name = 'WalletNotFoundError';
  }
}

export class WagerTransactionNotFoundError extends Error {
  constructor(transactionId: string) {
    super(`Wager transaction ${transactionId} was not found`);
    this.name = 'WagerTransactionNotFoundError';
  }
}

export class InvalidReferencedTransactionError extends Error {
  constructor(transactionId: string, public readonly failureCode = 'INVALID_REFERENCE') {
    super(`Wager transaction ${transactionId} has an invalid or unavailable reference`);
    this.name = 'InvalidReferencedTransactionError';
  }
}

export class WagerTransactionPendingReferenceError extends Error {
  constructor(transactionId: string) {
    super(`Wager transaction ${transactionId} is waiting for its reference`);
    this.name = 'WagerTransactionPendingReferenceError';
  }
}

@Injectable()
export class WalletMovementService {
  constructor(@Inject(WALLET_UNIT_OF_WORK) private readonly unitOfWork: WalletUnitOfWork) {}

  async debit(transactionId: string, processedAt?: Date): Promise<WalletBalanceChange> {
    return this.applyMovement(transactionId, LedgerDirection.Debit, processedAt);
  }

  async credit(
    transactionId: string,
    processedAt?: Date,
    onlyWhenReferenceRetryIsDue = false,
  ): Promise<WalletBalanceChange> {
    return this.applyMovement(
      transactionId,
      LedgerDirection.Credit,
      processedAt,
      onlyWhenReferenceRetryIsDue,
    );
  }

  async rollback(
    transactionId: string,
    processedAt?: Date,
    onlyWhenReferenceRetryIsDue = false,
  ): Promise<WalletBalanceChange> {
    return this.applyMovement(transactionId, undefined, processedAt, onlyWhenReferenceRetryIsDue);
  }

  async processLoss(transactionId: string, processedAt?: Date): Promise<Money> {
    return this.unitOfWork.execute(async ({ wallets, transactions }) => {
      const transaction = await transactions.findByIdForUpdate(transactionId);
      if (!transaction) {
        throw new WagerTransactionNotFoundError(transactionId);
      }
      if (transaction.status !== WagerTransactionStatus.Pending) {
        throw new InvalidWagerTransactionStateError(transaction.status);
      }
      if (transaction.kind !== WagerTransactionKind.Loss) {
        throw new InvalidWagerTransactionError('This movement handler only processes LOSS transactions');
      }

      const wallet = await wallets.findByIdForUpdate(transaction.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(transaction.walletId);
      }
      if (wallet.playerId !== transaction.playerId) {
        throw new InvalidWagerTransactionError('Transaction player does not match the wallet owner');
      }
      if (wallet.currency !== transaction.money.currency) {
        throw new InvalidWagerTransactionError('Transaction currency does not match the wallet currency');
      }

      transaction.markProcessed(undefined, processedAt ?? new Date(), wallet.balance);
      await transactions.save(transaction);
      return wallet.balance;
    });
  }

  private async applyMovement(
    transactionId: string,
    expectedDirection: LedgerDirection | undefined,
    processedAt?: Date,
    onlyWhenReferenceRetryIsDue = false,
  ): Promise<WalletBalanceChange> {
    const outcome = await this.unitOfWork.execute(async ({ wallets, ledger, transactions, outbox }) => {
      const transaction = await transactions.findByIdForUpdate(transactionId);
      if (!transaction) {
        throw new WagerTransactionNotFoundError(transactionId);
      }
      if (
        transaction.status !== WagerTransactionStatus.Pending &&
        transaction.status !== WagerTransactionStatus.PendingReference
      ) {
        throw new InvalidWagerTransactionStateError(transaction.status);
      }
      const at = processedAt ?? new Date();
      const nextReferenceAttemptAt = transaction.referenceNextAttemptAt;
      if (
        onlyWhenReferenceRetryIsDue &&
        transaction.status === WagerTransactionStatus.PendingReference &&
        nextReferenceAttemptAt !== undefined &&
        nextReferenceAttemptAt.getTime() > at.getTime()
      ) {
        return { pendingReference: new WagerTransactionPendingReferenceError(transaction.id) } as const;
      }
      const expectedKindIsSupported = expectedDirection === undefined
        ? transaction.kind === WagerTransactionKind.Rollback
        : expectedDirection === LedgerDirection.Debit
          ? transaction.kind === WagerTransactionKind.Bet
          : transaction.kind === WagerTransactionKind.Win || transaction.kind === WagerTransactionKind.Refund;
      if (!expectedKindIsSupported) {
        throw new InvalidWagerTransactionError(
          `This movement handler cannot process ${transaction.kind} transactions`,
        );
      }

      const reference = transaction.referenceExternalTransactionId
        ? await transactions.findByProviderAndExternalTransactionId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          )
        : undefined;
      if (transaction.referenceExternalTransactionId && !reference) {
        if (transaction.status === WagerTransactionStatus.Pending) {
          transaction.markPendingReference(referenceRetryAt(at, 1));
          await transactions.save(transaction);
          await enqueuePendingReferenceEvent(outbox, transaction, at);
        } else {
          const attempts = transaction.recordReferenceRetry(
            referenceRetryAt(at, transaction.referenceAttemptCount + 1),
          );
          if (attempts >= MAX_REFERENCE_ATTEMPTS) {
            return await persistRejection(transactions, outbox, transaction, 'REFERENCE_NOT_FOUND', at);
          }
          await transactions.save(transaction);
        }
        return { pendingReference: new WagerTransactionPendingReferenceError(transaction.id) } as const;
      }
      if (reference) {
        const allowedReferenceKinds = transaction.kind === WagerTransactionKind.Win ||
          transaction.kind === WagerTransactionKind.Refund
          ? [WagerTransactionKind.Bet]
          : [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
        if (!allowedReferenceKinds.includes(reference.kind)) {
          return await persistRejection(transactions, outbox, transaction, 'INVALID_REFERENCE', at);
        }
        if (
          reference.status === WagerTransactionStatus.Pending ||
          reference.status === WagerTransactionStatus.PendingReference
        ) {
          if (transaction.status === WagerTransactionStatus.Pending) {
            transaction.markPendingReference(referenceRetryAt(at, 1));
            await transactions.save(transaction);
            await enqueuePendingReferenceEvent(outbox, transaction, at);
          } else {
            const attempts = transaction.recordReferenceRetry(
              referenceRetryAt(at, transaction.referenceAttemptCount + 1),
            );
            if (attempts >= MAX_REFERENCE_ATTEMPTS) {
              return await persistRejection(transactions, outbox, transaction, 'REFERENCE_NOT_FOUND', at);
            }
            await transactions.save(transaction);
          }
          return { pendingReference: new WagerTransactionPendingReferenceError(transaction.id) } as const;
        }
        if (reference.status !== WagerTransactionStatus.Processed) {
          return await persistRejection(transactions, outbox, transaction, 'INVALID_REFERENCE', at);
        }
      }
      let direction: LedgerDirection | undefined;
      try {
        direction = transaction.ledgerDirectionFor(reference ?? undefined);
      } catch (error) {
        if (!(error instanceof InvalidWagerTransactionError) || !transaction.referenceExternalTransactionId) {
          throw error;
        }
        return await persistRejection(transactions, outbox, transaction, 'INVALID_REFERENCE', at);
      }
      if (direction === undefined) {
        throw new InvalidWagerTransactionError(`Transaction kind ${transaction.kind} has no ledger direction`);
      }
      if (expectedDirection !== undefined && direction !== expectedDirection) {
        throw new InvalidWagerTransactionError(
          `Transaction kind ${transaction.kind} cannot be processed as ${expectedDirection}`,
        );
      }

      const wallet = await wallets.findByIdForUpdate(transaction.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(transaction.walletId);
      }
      if (wallet.playerId !== transaction.playerId) {
        throw new InvalidWagerTransactionError('Transaction player does not match the wallet owner');
      }

      if (
        (transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Rollback) &&
        reference
      ) {
        const existingReversal = await transactions.findProcessedByReferenceAndKind(
          reference.id,
          transaction.kind,
        );
        if (existingReversal) {
          return await persistRejection(
            transactions,
            outbox,
            transaction,
            'REFERENCE_ALREADY_REVERSED',
            at,
          );
        }
      }

      let change: WalletBalanceChange;
      try {
        change =
          direction === LedgerDirection.Debit
            ? wallet.debit(transaction.money, at)
            : wallet.credit(transaction.money, at);
      } catch (error) {
        if (!(error instanceof InsufficientWalletFundsError)) {
          throw error;
        }

        const failureCode = transaction.kind === WagerTransactionKind.Rollback
          ? 'ROLLBACK_INSUFFICIENT_FUNDS'
          : 'INSUFFICIENT_FUNDS';
        transaction.reject(failureCode);
        await transactions.save(transaction);
        await outbox.save({
          id: crypto.randomUUID(),
          aggregateId: transaction.id,
          eventType: 'WagerTransactionRejected',
          version: 1,
          correlationId: transaction.idempotencyKey,
          causationId: transaction.id,
          occurredAt: at,
          data: {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            walletId: transaction.walletId,
            kind: transaction.kind,
            failureCode,
          },
        });
        return { failure: new InsufficientWalletFundsError(failureCode) } as const;
      }

      transaction.markProcessed(reference?.id, at, change.balanceAfter);
      const entry = WalletLedgerEntry.create({
        id: crypto.randomUUID(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction,
        money: change.money,
        balanceBefore: change.balanceBefore,
        balanceAfter: change.balanceAfter,
        createdAt: change.occurredAt,
      });

      await wallets.save(wallet);
      await ledger.save(entry);
      await transactions.save(transaction);
      return { change } as const;
    });

    if ('pendingReference' in outcome) {
      throw outcome.pendingReference;
    }
    if ('failure' in outcome) {
      throw outcome.failure;
    }
    return outcome.change;
  }
}
