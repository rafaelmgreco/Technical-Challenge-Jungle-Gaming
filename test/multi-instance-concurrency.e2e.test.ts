import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { AppModule } from '../src/app.module.js';
import { Money } from '../src/domain/money/money.js';
import { Wallet } from '../src/domain/wallet/wallet.js';
import { MikroOrmWalletRepository } from '../src/infrastructure/persistence/mikro-orm-wallet.repository.js';

describe('wagering across application instances (e2e)', () => {
  const apps: INestApplication[] = [];
  let orm: MikroORM;
  let wallet: Wallet;

  beforeAll(async () => {
    for (let index = 0; index < 3; index += 1) {
      const moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const app = moduleFixture.createNestApplication();
      await app.init();
      await app.listen(0, '127.0.0.1');
      apps.push(app);
    }

    orm = apps[0]!.get(MikroORM);
    await orm.migrator.up();
    wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `multi-instance-test-${crypto.randomUUID()}`,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    await new MikroOrmWalletRepository(orm.em.fork()).save(wallet);
  });

  afterAll(async () => {
    if (orm && wallet) {
      await orm.em.getConnection().execute(
        'delete from "integration_event_outbox" where "aggregate_id" in (select "id" from "wager_transactions" where "wallet_id" = ?)',
        [wallet.id],
      );
      await orm.em.getConnection().execute(
        'delete from "wallet_ledger_entries" where "wallet_id" = ?',
        [wallet.id],
      );
      await orm.em.getConnection().execute(
        'delete from "wager_transactions" where "wallet_id" = ?',
        [wallet.id],
      );
      await orm.em.getConnection().execute(
        'delete from "wallets" where "id" = ?',
        [wallet.id],
      );
    }
    await Promise.all(apps.map((app) => app.close()));
  });

  it('serializes competing bets across three independent app instances', async () => {
    const submissions = apps.map((_, index) => {
      const externalTransactionId = `three-instances-${index}-${crypto.randomUUID()}`;
      return {
        externalTransactionId,
        idempotencyKey: `multi-instance-provider:${externalTransactionId}`,
        body: {
          providerId: 'multi-instance-provider',
          externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'three-instances-round',
          gameId: 'three-instances-game',
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
        },
      };
    });

    const responses = await Promise.all(
      submissions.map(async (submission, index) => {
        const response = await fetch(
          `${await apps[index]!.getUrl()}/wagering/transactions`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': submission.idempotencyKey,
            },
            body: JSON.stringify(submission.body),
          },
        );
        return {
          statusCode: response.status,
          body: (await response.json()) as {
            transactionId: string;
            status: string;
            failureCode?: string;
            balance?: { amount: string; currency: string };
          },
        };
      }),
    );

    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 422)).toHaveLength(2);
    expect(
      responses.filter((response) => response.body.status === 'PROCESSED'),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.body.status === 'REJECTED'),
    ).toHaveLength(2);
    expect(
      responses
        .filter((response) => response.body.status === 'REJECTED')
        .every((response) => response.body.failureCode === 'INSUFFICIENT_FUNDS'),
    ).toBe(true);

    const persistedWallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(wallet.id);
    expect(persistedWallet?.balance.toJSON()).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });

    const transactions = await orm.em.getConnection().execute(
      'select "status", count(*)::int as count from "wager_transactions" where "wallet_id" = ? group by "status"',
      [wallet.id],
    );
    expect(
      Object.fromEntries(
        transactions.map((row: { status: string; count: number }) => [
          row.status,
          row.count,
        ]),
      ),
    ).toEqual({ PROCESSED: 1, REJECTED: 2 });

    const ledgerRows = await orm.em.getConnection().execute(
      'select count(*)::int as count from "wallet_ledger_entries" where "wallet_id" = ?',
      [wallet.id],
    );
    expect(ledgerRows[0].count).toBe(1);
  });
});
