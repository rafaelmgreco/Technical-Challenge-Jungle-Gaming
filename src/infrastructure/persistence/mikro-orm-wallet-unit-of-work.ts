import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import type {
  WalletRepositories,
  WalletUnitOfWork,
} from '../../application/ports/wallet-unit-of-work.js';
import { MikroOrmWalletRepository } from './mikro-orm-wallet.repository.js';
import { MikroOrmWalletLedgerRepository } from './mikro-orm-wallet-ledger.repository.js';
import { MikroOrmWagerTransactionRepository } from './mikro-orm-wager-transaction.repository.js';
import { MikroOrmIntegrationEventOutboxRepository } from './mikro-orm-integration-event-outbox.repository.js';
import { MikroOrmInboxMessageRepository } from './mikro-orm-inbox-message.repository.js';
import { MetricsRegistry } from '../metrics/metrics.registry.js';

const LOCK_CONFLICT_POSTGRES_CODES = new Set(['40P01', '55P03', '40001']);

function isLockConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      typeof current.code === 'string' &&
      LOCK_CONFLICT_POSTGRES_CODES.has(current.code)
    ) {
      return true;
    }
    current =
      typeof current === 'object' && 'cause' in current
        ? current.cause
        : undefined;
  }
  return false;
}

@Injectable()
export class MikroOrmWalletUnitOfWork implements WalletUnitOfWork {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(MetricsRegistry)
    private readonly metrics: MetricsRegistry = new MetricsRegistry(),
  ) {}

  async execute<T>(
    operation: (repositories: WalletRepositories) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.em.transactional((transactionalEm) =>
        operation({
          wallets: new MikroOrmWalletRepository(transactionalEm),
          ledger: new MikroOrmWalletLedgerRepository(transactionalEm),
          transactions: new MikroOrmWagerTransactionRepository(transactionalEm),
          outbox: new MikroOrmIntegrationEventOutboxRepository(transactionalEm),
          inbox: new MikroOrmInboxMessageRepository(transactionalEm),
        }),
      );
    } catch (error) {
      if (isLockConflict(error)) this.metrics.recordLockConflict();
      throw error;
    }
  }
}
