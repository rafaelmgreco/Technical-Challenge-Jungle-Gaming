import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Money } from '../src/domain/money/money.js';
import { Wallet } from '../src/domain/wallet/wallet.js';
import mikroOrmConfig from '../src/infrastructure/database/mikro-orm.config.js';
import { MikroOrmWalletRepository } from '../src/infrastructure/persistence/mikro-orm-wallet.repository.js';

describe('MikroORM wallet repository', () => {
  let orm: MikroORM;
  let repository: MikroOrmWalletRepository;
  const playerId = `wallet-repository-test-${crypto.randomUUID()}`;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
    repository = new MikroOrmWalletRepository(orm.em.fork());
  });

  afterAll(async () => {
    if (orm) {
      await orm.em.getConnection().execute('delete from "wallets" where "player_id" like ?', [`${playerId}%`]);
      await orm.close(true);
    }
  });

  it('saves and reloads a wallet without losing exact balance, version, or timestamps', async () => {
    const openedAt = new Date('2026-11-16T12:00:00.000Z');
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `${playerId}-roundtrip`,
      initialBalance: Money.from({ amount: '125.47', currency: 'BRL' }),
      openedAt,
    });

    await repository.save(wallet);
    const reloaded = await repository.findById(wallet.id);

    expect(reloaded).not.toBeNull();
    expect(reloaded?.playerId).toBe(wallet.playerId);
    expect(reloaded?.balance.toJSON()).toEqual({ amount: '125.47', currency: 'BRL' });
    expect(reloaded?.version).toBe(1);
    expect(reloaded?.createdAt.toISOString()).toBe(openedAt.toISOString());
    expect(reloaded?.updatedAt.toISOString()).toBe(openedAt.toISOString());

    reloaded?.debit(Money.from({ amount: '0.47', currency: 'BRL' }), new Date('2026-11-16T12:01:00.000Z'));
    if (!reloaded) {
      throw new Error('Expected wallet to be reloaded');
    }
    await repository.save(reloaded);

    const updated = await repository.findById(wallet.id);
    expect(updated?.balance.toJSON()).toEqual({ amount: '125.00', currency: 'BRL' });
    expect(updated?.version).toBe(2);
    expect(updated?.updatedAt.toISOString()).toBe('2026-11-16T12:01:00.000Z');
  });

  it('finds a wallet by player and currency while allowing another currency for that player', async () => {
    const brlWallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `${playerId}-currency`,
      initialBalance: Money.zero('BRL'),
    });
    const usdWallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `${playerId}-currency`,
      initialBalance: Money.zero('USD'),
    });

    await repository.save(brlWallet);
    await repository.save(usdWallet);

    expect((await repository.findByPlayerAndCurrency(brlWallet.playerId, 'BRL'))?.id).toBe(brlWallet.id);
    expect((await repository.findByPlayerAndCurrency(brlWallet.playerId, 'USD'))?.id).toBe(usdWallet.id);
    expect(await repository.findById('missing-wallet')).toBeNull();
  });
});
