import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Money } from '../src/domain/money/money.js';
import { Wallet } from '../src/domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/domain/wager-transaction/wager-transaction.js';
import mikroOrmConfig from '../src/infrastructure/database/mikro-orm.config.js';
import { MikroOrmWalletRepository } from '../src/infrastructure/persistence/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../src/infrastructure/persistence/mikro-orm-wager-transaction.repository.js';

async function expectConstraintViolation(operation: Promise<unknown>): Promise<void> {
  let wasRejected = false;

  try {
    await operation;
  } catch {
    wasRejected = true;
  }

  expect(wasRejected).toBe(true);
}

describe('MikroORM wager transaction repository', () => {
  let orm: MikroORM;
  let repository: MikroOrmWagerTransactionRepository;
  let wallet: Wallet;
  const providerId = `transaction-repository-provider-${crypto.randomUUID()}`;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
    wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `transaction-repository-player-${crypto.randomUUID()}`,
      initialBalance: Money.zero('BRL'),
    });
    await new MikroOrmWalletRepository(orm.em.fork()).save(wallet);
    repository = new MikroOrmWagerTransactionRepository(orm.em.fork());
  });

  afterAll(async () => {
    if (orm && wallet) {
      await orm.em.getConnection().execute(
        'delete from "wallet_ledger_entries" where "wallet_id" = ?',
        [wallet.id],
      );
      await orm.em.getConnection().execute('delete from "wager_transactions" where "wallet_id" = ?', [wallet.id]);
      await orm.em.getConnection().execute('delete from "wallets" where "id" = ?', [wallet.id]);
      await orm.close(true);
    }
  });

  it('saves and reloads wager identity, amount, and lifecycle state', async () => {
    const transaction = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId,
      externalTransactionId: 'external-bet-1',
      idempotencyKey: 'request-bet-1',
      payloadHash: 'payload-hash-1',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '12.34', currency: 'BRL' }),
      createdAt: new Date('2026-11-16T12:00:00.000Z'),
    });

    await repository.save(transaction);
    const pending = await repository.findById(transaction.id);
    expect(pending?.status).toBe(WagerTransactionStatus.Pending);
    expect(pending?.money.toJSON()).toEqual({ amount: '12.34', currency: 'BRL' });
    expect(
      (await repository.findByProviderAndIdempotencyKey(providerId, 'request-bet-1'))?.id,
    ).toBe(transaction.id);

    const processedAt = new Date('2026-11-16T12:01:00.000Z');
    transaction.markProcessed(undefined, processedAt);
    await repository.save(transaction);

    const processed = await new MikroOrmWagerTransactionRepository(orm.em.fork()).findById(transaction.id);
    expect(processed?.status).toBe(WagerTransactionStatus.Processed);
    expect(processed?.processedAt?.toISOString()).toBe(processedAt.toISOString());
  });

  it('enforces idempotency-key uniqueness per provider', async () => {
    const duplicate = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId,
      externalTransactionId: 'external-bet-2',
      idempotencyKey: 'request-bet-1',
      payloadHash: 'different-payload-hash',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-2',
      gameId: 'game-2',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '1.00', currency: 'BRL' }),
      createdAt: new Date('2026-11-16T12:02:00.000Z'),
    });

    await expectConstraintViolation(repository.save(duplicate));
  });
});
