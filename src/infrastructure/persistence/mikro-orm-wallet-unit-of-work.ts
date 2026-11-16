import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import type { WalletRepository } from '../../application/ports/wallet.repository.js';
import type { WalletUnitOfWork } from '../../application/ports/wallet-unit-of-work.js';
import { MikroOrmWalletRepository } from './mikro-orm-wallet.repository.js';

@Injectable()
export class MikroOrmWalletUnitOfWork implements WalletUnitOfWork {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  execute<T>(operation: (wallets: WalletRepository) => Promise<T>): Promise<T> {
    return this.em.transactional((transactionalEm) =>
      operation(new MikroOrmWalletRepository(transactionalEm)),
    );
  }
}
