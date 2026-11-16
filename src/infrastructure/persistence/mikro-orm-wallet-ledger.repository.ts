import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { Money } from '../../domain/money/money.js';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger/ledger-entry.js';
import type { WalletLedgerRepository } from '../../application/ports/wallet-ledger.repository.js';
import { WalletLedgerEntryEntity } from '../database/wallet-ledger-entry.entity.js';

@Injectable()
export class MikroOrmWalletLedgerRepository implements WalletLedgerRepository {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async findByWalletAndTransactionId(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | null> {
    const entity = await this.em.findOne(WalletLedgerEntryEntity, { walletId, transactionId });
    return entity ? this.toDomain(entity) : null;
  }

  async findByWallet(walletId: string): Promise<WalletLedgerEntry[]> {
    const entities = await this.em.find(
      WalletLedgerEntryEntity,
      { walletId },
      { orderBy: { createdAt: 'ASC', id: 'ASC' } },
    );
    return entities.map((entity) => this.toDomain(entity));
  }

  async save(entry: WalletLedgerEntry): Promise<void> {
    const entity = this.em.create(WalletLedgerEntryEntity, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      currency: entry.money.currency,
      amountMinorUnits: entry.money.toMinorUnits(),
      balanceBeforeMinorUnits: entry.balanceBefore.toMinorUnits(),
      balanceAfterMinorUnits: entry.balanceAfter.toMinorUnits(),
      createdAt: entry.createdAt,
    });

    this.em.persist(entity);
    await this.em.flush();
  }

  private toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction as LedgerDirection,
      money: Money.fromMinorUnits(entity.amountMinorUnits, entity.currency).toJSON(),
      balanceBefore: Money.fromMinorUnits(entity.balanceBeforeMinorUnits, entity.currency).toJSON(),
      balanceAfter: Money.fromMinorUnits(entity.balanceAfterMinorUnits, entity.currency).toJSON(),
      createdAt: entity.createdAt,
    });
  }
}
