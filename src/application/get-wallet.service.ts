import { Inject, Injectable } from '@nestjs/common';
import type { Wallet } from '../domain/wallet/wallet.js';
import {
  WALLET_UNIT_OF_WORK,
  type WalletUnitOfWork,
} from './ports/wallet-unit-of-work.js';

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} was not found`);
    this.name = 'WalletNotFoundError';
  }
}

@Injectable()
export class GetWalletService {
  constructor(
    @Inject(WALLET_UNIT_OF_WORK)
    private readonly unitOfWork: WalletUnitOfWork,
  ) {}

  async get(walletId: string): Promise<Wallet> {
    const wallet = await this.unitOfWork.execute(({ wallets }) =>
      wallets.findById(walletId),
    );
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }
}
