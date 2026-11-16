import { Inject, Injectable } from '@nestjs/common';
import type { WagerTransaction } from '../domain/wager-transaction/wager-transaction.js';
import {
  WALLET_UNIT_OF_WORK,
  type WalletUnitOfWork,
} from './ports/wallet-unit-of-work.js';

export class WagerTransactionNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Wager transaction ${identifier} was not found`);
    this.name = 'WagerTransactionNotFoundError';
  }
}

@Injectable()
export class GetWagerTransactionService {
  constructor(
    @Inject(WALLET_UNIT_OF_WORK)
    private readonly unitOfWork: WalletUnitOfWork,
  ) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.unitOfWork.execute(({ transactions }) =>
      transactions.findById(transactionId),
    );
    if (!transaction) throw new WagerTransactionNotFoundError(transactionId);
    return transaction;
  }

  async byProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const transaction = await this.unitOfWork.execute(({ transactions }) =>
      transactions.findByProviderAndExternalTransactionId(
        providerId,
        externalTransactionId,
      ),
    );
    if (!transaction) {
      throw new WagerTransactionNotFoundError(
        `${providerId}/${externalTransactionId}`,
      );
    }
    return transaction;
  }
}
