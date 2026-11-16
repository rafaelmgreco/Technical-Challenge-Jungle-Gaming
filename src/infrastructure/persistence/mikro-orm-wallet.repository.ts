import { Inject, Injectable } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/core';
import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import type { WalletRepository } from '../../application/ports/wallet.repository.js';
import { WalletEntity } from '../database/wallet.entity.js';

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id });
    return entity ? this.toDomain(entity) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(
      WalletEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return entity ? this.toDomain(entity) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { playerId, currency });
    return entity ? this.toDomain(entity) : null;
  }

  async save(wallet: Wallet): Promise<void> {
    let entity = await this.em.findOne(WalletEntity, { id: wallet.id });

    if (!entity) {
      entity = this.em.create(WalletEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balanceMinorUnits: wallet.balance.toMinorUnits(),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
    } else {
      entity.playerId = wallet.playerId;
      entity.currency = wallet.currency;
      entity.balanceMinorUnits = wallet.balance.toMinorUnits();
      entity.version = wallet.version;
      entity.createdAt = wallet.createdAt;
      entity.updatedAt = wallet.updatedAt;
    }

    this.em.persist(entity);
    await this.em.flush();
  }

  private toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      balance: Money.fromMinorUnits(entity.balanceMinorUnits, entity.currency).toJSON(),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }
}
