import { Inject, Injectable } from '@nestjs/common';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger/ledger-entry.js';
import type { WalletBalanceChange } from '../domain/wallet/wallet.js';
import { InsufficientWalletFundsError } from '../domain/wallet/wallet.js';
import { Money } from '../domain/money/money.js';
import {
  InvalidWagerTransactionError,
  InvalidWagerTransactionStateError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction/wager-transaction.js';
import { WALLET_UNIT_OF_WORK, type WalletUnitOfWork } from './ports/wallet-unit-of-work.js';

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
  constructor(transactionId: string) {
    super(`Wager transaction ${transactionId} has an invalid or unavailable reference`);
    this.name = 'InvalidReferencedTransactionError';
  }
}

@Injectable()
export class WalletMovementService {
  constructor(@Inject(WALLET_UNIT_OF_WORK) private readonly unitOfWork: WalletUnitOfWork) {}

  async debit(transactionId: string, processedAt?: Date): Promise<WalletBalanceChange> {
    return this.applyMovement(transactionId, LedgerDirection.Debit, processedAt);
  }

  async credit(transactionId: string, processedAt?: Date): Promise<WalletBalanceChange> {
    return this.applyMovement(transactionId, LedgerDirection.Credit, processedAt);
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
    expectedDirection: LedgerDirection,
    processedAt?: Date,
  ): Promise<WalletBalanceChange> {
    const outcome = await this.unitOfWork.execute(async ({ wallets, ledger, transactions }) => {
      const transaction = await transactions.findByIdForUpdate(transactionId);
      if (!transaction) {
        throw new WagerTransactionNotFoundError(transactionId);
      }
      if (transaction.status !== WagerTransactionStatus.Pending) {
        throw new InvalidWagerTransactionStateError(transaction.status);
      }
      const expectedKind =
        expectedDirection === LedgerDirection.Debit
          ? WagerTransactionKind.Bet
          : WagerTransactionKind.Win;
      if (transaction.kind !== expectedKind) {
        throw new InvalidWagerTransactionError(
          `This movement handler only processes ${expectedKind} transactions`,
        );
      }

      const reference = transaction.referenceExternalTransactionId
        ? await transactions.findByProviderAndExternalTransactionId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          )
        : undefined;
      let direction: LedgerDirection | undefined;
      try {
        direction = transaction.ledgerDirectionFor(reference ?? undefined);
      } catch (error) {
        if (!(error instanceof InvalidWagerTransactionError) || !transaction.referenceExternalTransactionId) {
          throw error;
        }
        transaction.reject('INVALID_REFERENCE');
        await transactions.save(transaction);
        return { failure: new InvalidReferencedTransactionError(transaction.id) } as const;
      }
      if (direction !== expectedDirection) {
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

      const at = processedAt ?? new Date();
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

        transaction.reject('INSUFFICIENT_FUNDS');
        await transactions.save(transaction);
        return { failure: error } as const;
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

    if ('failure' in outcome) {
      throw outcome.failure;
    }
    return outcome.change;
  }
}
