import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger/ledger-entry.js';
import { Money } from '../domain/money/money.js';
import { Wallet } from '../domain/wallet/wallet.js';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction/wager-transaction.js';
import { WALLET_UNIT_OF_WORK, type WalletUnitOfWork } from './ports/wallet-unit-of-work.js';

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Wallet for player ${playerId} and currency ${currency} already exists`);
    this.name = 'WalletAlreadyExistsError';
  }
}

@Injectable()
export class CreateWalletService {
  constructor(@Inject(WALLET_UNIT_OF_WORK) private readonly unitOfWork: WalletUnitOfWork) {}

  async create(playerId: string, initialBalance: Money): Promise<Wallet> {
    const openedAt = new Date();
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId,
      initialBalance,
      openedAt,
    });

    try {
      return await this.unitOfWork.execute(async ({ wallets, ledger, transactions }) => {
        const existing = await wallets.findByPlayerAndCurrency(playerId, initialBalance.currency);
        if (existing) {
          throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
        }

        await wallets.save(wallet);
        if (initialBalance.isPositive()) {
          const transaction = WagerTransaction.create({
            id: crypto.randomUUID(),
            providerId: 'internal',
            externalTransactionId: `wallet-opening:${wallet.id}`,
            idempotencyKey: `wallet-opening:${wallet.id}`,
            payloadHash: createHash('sha256')
              .update(`${wallet.id}:${playerId}:${initialBalance.toString()}:${initialBalance.currency}`)
              .digest('hex'),
            walletId: wallet.id,
            playerId,
            roundId: 'wallet-opening',
            gameId: 'system',
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
            createdAt: openedAt,
          });
          transaction.markProcessed(undefined, openedAt, initialBalance);

          const entry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(initialBalance.currency),
            balanceAfter: initialBalance,
            createdAt: openedAt,
          });

          await transactions.save(transaction);
          await ledger.save(entry);
        }

        return wallet;
      });
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw error;
      }

      const existing = await this.unitOfWork.execute(({ wallets }) =>
        wallets.findByPlayerAndCurrency(playerId, initialBalance.currency),
      );
      if (existing) {
        throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
