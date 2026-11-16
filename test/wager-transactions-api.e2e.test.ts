import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { Money } from '../src/domain/money/money.js';
import { Wallet } from '../src/domain/wallet/wallet.js';
import { MikroOrmWalletRepository } from '../src/infrastructure/persistence/mikro-orm-wallet.repository.js';

describe('WagerTransactionsController (e2e)', () => {
  let app: INestApplication<App>;
  let orm: MikroORM;
  let wallet: Wallet;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    orm = app.get(MikroORM);
    await orm.migrator.up();
    wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `http-provider-test-${crypto.randomUUID()}`,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    await new MikroOrmWalletRepository(orm.em.fork()).save(wallet);
  });

  afterEach(async () => {
    if (orm && wallet) {
      await orm.em.getConnection().execute(
        'delete from "wallet_ledger_entries" where "wallet_id" = ?',
        [wallet.id],
      );
      await orm.em.getConnection().execute('delete from "wager_transactions" where "wallet_id" = ?', [wallet.id]);
      await orm.em.getConnection().execute('delete from "wallets" where "id" = ?', [wallet.id]);
    }
    if (app) {
      await app.close();
    }
  });

  it('submits a BET and returns the same stored result on retry', async () => {
    const body = {
      providerId: 'http-provider',
      externalTransactionId: 'http-bet-1',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'http-round-1',
      gameId: 'http-game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:http-bet-1')
      .send(body)
      .expect(201);

    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const retry = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:http-bet-1')
      .send({
        money: body.money,
        kind: body.kind,
        gameId: body.gameId,
        roundId: body.roundId,
        walletId: body.walletId,
        playerId: body.playerId,
        externalTransactionId: body.externalTransactionId,
        providerId: body.providerId,
      })
      .expect(200);

    expect(retry.body).toEqual({
      transactionId: first.body.transactionId,
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    });

    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
  });

  it('submits a WIN and credits the wallet', async () => {
    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:http-win-1')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'http-win-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'http-round-win',
        gameId: 'http-game-win',
        kind: 'WIN',
        money: { amount: '5.00', currency: 'BRL' },
      })
      .expect(201);

    expect(response.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '105.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('returns a conflict when the same key is used for a different payload', async () => {
    const body = {
      providerId: 'http-provider',
      externalTransactionId: 'http-bet-2',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'http-round-2',
      gameId: 'http-game-2',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const key = 'http-provider:conflicting-key';

    await request(app.getHttpServer()).post('/wagering/transactions').set('Idempotency-Key', key).send(body).expect(201);
    const conflict = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send({ ...body, money: { amount: '11.00', currency: 'BRL' } })
      .expect(409);

    expect(conflict.body.code).toBe('TRANSACTION_CONFLICT');
  });

  it('returns an auditable insufficient-funds rejection and requires the idempotency header', async () => {
    const body = {
      providerId: 'http-provider',
      externalTransactionId: 'http-bet-3',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'http-round-3',
      gameId: 'http-game-3',
      kind: 'BET',
      money: { amount: '150.00', currency: 'BRL' },
    };
    const key = 'http-provider:http-bet-3';

    const rejected = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(422);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: false,
    });

    const retry = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(422);
    expect(retry.body).toMatchObject({
      transactionId: rejected.body.transactionId,
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: true,
    });

    await request(app.getHttpServer()).post('/wagering/transactions').send(body).expect(400);
    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });
});
