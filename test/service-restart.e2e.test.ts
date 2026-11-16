import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';

async function startApplication(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}

describe('service restart recovery (e2e)', () => {
  let app: INestApplication<App>;
  let orm: MikroORM;
  let playerId: string;
  let walletId: string;

  beforeAll(async () => {
    app = await startApplication();
    orm = app.get(MikroORM);
    await orm.migrator.up();
    playerId = `restart-test-${crypto.randomUUID()}`;
  });

  afterAll(async () => {
    if (orm && playerId) {
      await orm.em.getConnection().execute(
        'delete from "integration_event_outbox" where "aggregate_id" in (select "id" from "wager_transactions" where "player_id" = ?)',
        [playerId],
      );
      await orm.em.getConnection().execute(
        'delete from "wallet_ledger_entries" where "wallet_id" in (select "id" from "wallets" where "player_id" = ?)',
        [playerId],
      );
      await orm.em.getConnection().execute(
        'delete from "wager_transactions" where "player_id" = ?',
        [playerId],
      );
      await orm.em.getConnection().execute(
        'delete from "wallets" where "player_id" = ?',
        [playerId],
      );
    }
    if (app) await app.close();
  });

  it('recovers the wallet, ledger, and idempotent result after restarting Nest', async () => {
    const createdWallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    walletId = createdWallet.body.id as string;

    const transaction = {
      providerId: 'restart-provider',
      externalTransactionId: 'restart-bet',
      playerId,
      walletId,
      roundId: 'restart-round',
      gameId: 'restart-game',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const firstResult = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'restart-provider:restart-bet')
      .send(transaction)
      .expect(201);
    expect(firstResult.body.balance).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });

    await app.close();
    app = await startApplication();
    orm = app.get(MikroORM);
    await orm.migrator.up();

    const recoveredWallet = await request(app.getHttpServer())
      .get(`/wallets/${walletId}`)
      .expect(200);
    expect(recoveredWallet.body).toEqual({
      id: walletId,
      playerId,
      balance: { amount: '75.00', currency: 'BRL' },
      version: 2,
    });

    const replayedResult = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'restart-provider:restart-bet')
      .send(transaction)
      .expect(200);
    expect(replayedResult.body).toEqual({
      ...firstResult.body,
      idempotentReplay: true,
    });

    const reconciliation = await request(app.getHttpServer())
      .post(`/wallets/${walletId}/reconciliation`)
      .expect(201);
    expect(reconciliation.body).toEqual({
      walletId,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });
});
