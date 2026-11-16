import { Inject, Injectable } from '@nestjs/common';
import type { Money } from '../domain/money/money.js';
import type { WalletBalanceChange } from '../domain/wallet/wallet.js';
import { WALLET_UNIT_OF_WORK, type WalletUnitOfWork } from './ports/wallet-unit-of-work.js';

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} was not found`);
    this.name = 'WalletNotFoundError';
  }
}

@Injectable()
export class WalletMovementService {
  constructor(@Inject(WALLET_UNIT_OF_WORK) private readonly unitOfWork: WalletUnitOfWork) {}

  async debit(walletId: string, money: Money, occurredAt?: Date): Promise<WalletBalanceChange> {
    return this.unitOfWork.execute(async (wallets) => {
      const wallet = await wallets.findByIdForUpdate(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }

      const change = wallet.debit(money, occurredAt);
      await wallets.save(wallet);
      return change;
    });
  }

  async credit(walletId: string, money: Money, occurredAt?: Date): Promise<WalletBalanceChange> {
    return this.unitOfWork.execute(async (wallets) => {
      const wallet = await wallets.findByIdForUpdate(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }

      const change = wallet.credit(money, occurredAt);
      await wallets.save(wallet);
      return change;
    });
  }
}
