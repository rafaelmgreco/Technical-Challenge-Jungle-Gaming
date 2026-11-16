import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Money } from '../src/domain/money/money.js';
import { Wallet } from '../src/domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../src/domain/wager-transaction/wager-transaction.js';
import mikroOrmConfig from '../src/infrastructure/database/mikro-orm.config.js';
import { MikroOrmIntegrationEventOutboxRepository } from '../src/infrastructure/persistence/mikro-orm-integration-event-outbox.repository.js';
import { MikroOrmWalletRepository } from '../src/infrastructure/persistence/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../src/infrastructure/persistence/mikro-orm-wager-transaction.repository.js';

describe('integration event outbox claims', () => {
  let orm: MikroORM;
  const playerId = `outbox-claim-test-${crypto.randomUUID()}`;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
  });

  afterAll(async () => {
    if (!orm) return;
    await orm.em
      .getConnection()
      .execute(
        'delete from "integration_event_outbox" where "aggregate_id" in (select "id" from "wager_transactions" where "player_id" = ?)',
        [playerId],
      );
    await orm.em
      .getConnection()
      .execute('delete from "wager_transactions" where "player_id" = ?', [
        playerId,
      ]);
    await orm.em
      .getConnection()
      .execute('delete from "wallets" where "player_id" = ?', [playerId]);
    await orm.close(true);
  });

  it('claims due events without giving the same event to concurrent workers and releases them after publishing', async () => {
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId,
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    await new MikroOrmWalletRepository(orm.em.fork()).save(wallet);

    const transactions = Array.from({ length: 2 }, (_, index) =>
      WagerTransaction.create({
        id: crypto.randomUUID(),
        providerId: 'outbox-test-provider',
        externalTransactionId: `outbox-${crypto.randomUUID()}`,
        idempotencyKey: `outbox-${crypto.randomUUID()}`,
        payloadHash: 'outbox-test-payload',
        walletId: wallet.id,
        playerId,
        roundId: 'outbox-test-round',
        gameId: 'outbox-test-game',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '1.00', currency: 'BRL' }),
        createdAt: new Date(Date.now() + index),
      }),
    );
    await Promise.all(
      transactions.map((transaction) =>
        new MikroOrmWagerTransactionRepository(orm.em.fork()).save(transaction),
      ),
    );

    const writer = new MikroOrmIntegrationEventOutboxRepository(orm.em.fork());
    for (const transaction of transactions) {
      await writer.save({
        id: crypto.randomUUID(),
        aggregateId: transaction.id,
        eventType: 'WagerTransactionRejected',
        version: 1,
        correlationId: crypto.randomUUID(),
        occurredAt: new Date('2026-11-16T12:00:00.000Z'),
        data: {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          walletId: wallet.id,
          kind: transaction.kind,
          failureCode: 'TEST_REJECTION',
        },
      });
    }

    const at = new Date('2026-11-16T12:01:00.000Z');
    const [firstWorker, secondWorker] = await Promise.all([
      new MikroOrmIntegrationEventOutboxRepository(orm.em.fork()).claimDue({
        workerId: 'worker-one',
        at,
        leaseUntil: new Date(at.getTime() + 30_000),
        limit: 10,
      }),
      new MikroOrmIntegrationEventOutboxRepository(orm.em.fork()).claimDue({
        workerId: 'worker-two',
        at,
        leaseUntil: new Date(at.getTime() + 30_000),
        limit: 10,
      }),
    ]);

    expect(firstWorker.length + secondWorker.length).toBe(2);
    expect(
      new Set([...firstWorker, ...secondWorker].map(({ id }) => id)).size,
    ).toBe(2);

    const claimed = [...firstWorker, ...secondWorker][0]!;
    const owner = firstWorker.includes(claimed) ? 'worker-one' : 'worker-two';
    const repository = new MikroOrmIntegrationEventOutboxRepository(
      orm.em.fork(),
    );
    expect(
      await repository.markPublished({
        eventId: claimed.id,
        workerId: owner,
        at,
      }),
    ).toBe(true);
    expect(
      await repository.markPublished({
        eventId: claimed.id,
        workerId: 'wrong-worker',
        at,
      }),
    ).toBe(false);

    const released = await repository.claimDue({
      workerId: 'worker-three',
      at,
      leaseUntil: new Date(at.getTime() + 30_000),
      limit: 10,
    });
    expect(released).toHaveLength(0);

    const expiredLease = await repository.claimDue({
      workerId: 'worker-three',
      at: new Date(at.getTime() + 31_000),
      leaseUntil: new Date(at.getTime() + 61_000),
      limit: 10,
    });
    expect(expiredLease).toHaveLength(1);

    const retriedEvent = expiredLease[0]!;
    const nextAttemptAt = new Date(at.getTime() + 32_000);
    expect(
      await repository.scheduleRetry({
        eventId: retriedEvent.id,
        workerId: 'worker-three',
        nextAttemptAt,
      }),
    ).toBe(true);
    expect(
      await repository.claimDue({
        workerId: 'worker-four',
        at: new Date(at.getTime() + 31_999),
        leaseUntil: new Date(at.getTime() + 61_999),
        limit: 10,
      }),
    ).toHaveLength(0);
    const dueAgain = await repository.claimDue({
      workerId: 'worker-four',
      at: nextAttemptAt,
      leaseUntil: new Date(nextAttemptAt.getTime() + 30_000),
      limit: 10,
    });
    expect(dueAgain).toHaveLength(1);
    expect(dueAgain[0]?.attempts).toBe(1);
  });
});
