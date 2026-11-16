import { Inject, Injectable } from '@nestjs/common';
import { Money } from '../domain/money/money.js';
import {
  WALLET_UNIT_OF_WORK,
  type WalletUnitOfWork,
} from './ports/wallet-unit-of-work.js';

export class WalletNotFoundForReconciliationError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} was not found`);
    this.name = 'WalletNotFoundForReconciliationError';
  }
}

@Injectable()
export class ReconcileWalletService {
  constructor(
    @Inject(WALLET_UNIT_OF_WORK)
    private readonly unitOfWork: WalletUnitOfWork,
  ) {}

  async reconcile(walletId: string): Promise<{
    walletId: string;
    storedBalance: ReturnType<Money['toJSON']>;
    calculatedBalance: ReturnType<Money['toJSON']>;
    difference: ReturnType<Money['toJSON']>;
    consistent: boolean;
    checkedEntries: number;
  }> {
    return this.unitOfWork.execute(async ({ wallets, ledger }) => {
      const wallet = await wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundForReconciliationError(walletId);
      }

      const entries = await ledger.findByWallet(walletId);
      let calculatedMinorUnits = 0n;
      let entriesAreValid = true;

      for (const entry of entries) {
        if (entry.money.currency !== wallet.currency) {
          entriesAreValid = false;
          continue;
        }
        if (!entry.isBalanced()) {
          entriesAreValid = false;
        }

        calculatedMinorUnits +=
          entry.direction === 'DEBIT'
            ? -entry.money.toMinorUnits()
            : entry.money.toMinorUnits();
      }

      const calculatedBalance = Money.fromMinorUnits(
        calculatedMinorUnits,
        wallet.currency,
      );
      const difference = wallet.balance.subtract(calculatedBalance);

      return {
        walletId: wallet.id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent: entriesAreValid && difference.isZero(),
        checkedEntries: entries.length,
      };
    });
  }
}
