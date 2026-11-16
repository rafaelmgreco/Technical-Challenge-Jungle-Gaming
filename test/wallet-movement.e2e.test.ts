import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Money } from '../src/domain/money/money.js';
import { InsufficientWalletFundsError, Wallet } from '../src/domain/wallet/wallet.js';
import mikroOrmConfig from '../src/infrastructure/database/mikro-orm.config.js';
import { MikroOrmWalletRepository } from '../src/infrastructure/persistence/mikro-orm-wallet.repository.js';
import { MikroOrmWalletUnitOfWork } from '../src/infrastructure/persistence/mikro-orm-wallet-unit-of-work.js';
import { WalletMovementService } from '../src/application/wallet-movement.service.js';

describe('wallet movement transactions', () => {
  let orm: MikroORM;
  let movementService: WalletMovementService;
  const playerId = `wallet-movement-test-${crypto.randomUUID()}`;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
    movementService = new WalletMovementService(new MikroOrmWalletUnitOfWork(orm.em));
  });

  afterAll(async () => {
    if (orm) {
      await orm.em.getConnection().execute('delete from "wallets" where "player_id" like ?', [`${playerId}%`]);
      await orm.close(true);
    }
  });

  it('serializes concurrent debits so only one can spend the available balance', async () => {
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `${playerId}-race`,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    await new MikroOrmWalletRepository(orm.em.fork()).save(wallet);

    const results = await Promise.allSettled([
      movementService.debit(wallet.id, Money.from({ amount: '80.00', currency: 'BRL' })),
      movementService.debit(wallet.id, Money.from({ amount: '80.00', currency: 'BRL' })),
    ]);

    const successful = results.filter((result) => result.status === 'fulfilled');
    const failed = results.find((result) => result.status === 'rejected');
    expect(successful).toHaveLength(1);
    expect(failed?.status).toBe('rejected');
    if (failed?.status === 'rejected') {
      expect(failed.reason).toBeInstanceOf(InsufficientWalletFundsError);
    }

    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(persisted?.version).toBe(2);
  });
});
