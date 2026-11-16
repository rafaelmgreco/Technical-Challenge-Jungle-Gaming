import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import type { WalletRepositories, WalletUnitOfWork } from '../../application/ports/wallet-unit-of-work.js';
import { MikroOrmWalletRepository } from './mikro-orm-wallet.repository.js';
import { MikroOrmWalletLedgerRepository } from './mikro-orm-wallet-ledger.repository.js';
import { MikroOrmWagerTransactionRepository } from './mikro-orm-wager-transaction.repository.js';

@Injectable()
export class MikroOrmWalletUnitOfWork implements WalletUnitOfWork {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  execute<T>(operation: (repositories: WalletRepositories) => Promise<T>): Promise<T> {
    return this.em.transactional((transactionalEm) =>
      operation({
        wallets: new MikroOrmWalletRepository(transactionalEm),
        ledger: new MikroOrmWalletLedgerRepository(transactionalEm),
        transactions: new MikroOrmWagerTransactionRepository(transactionalEm),
      }),
    );
  }
}
