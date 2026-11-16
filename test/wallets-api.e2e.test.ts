import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';

describe('WalletsController (e2e)', () => {
  let app: INestApplication<App>;
  let orm: MikroORM;
  let playerId: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    orm = app.get(MikroORM);
    await orm.migrator.up();
    playerId = `wallet-api-test-${crypto.randomUUID()}`;
  });

  afterEach(async () => {
    if (orm && playerId) {
      await orm.em.getConnection().execute(
        'delete from "integration_event_outbox" where "aggregate_id" in (select "id" from "wager_transactions" where "player_id" = ?)',
        [playerId],
      );
      await orm.em.getConnection().execute(
        'delete from "wallet_ledger_entries" where "wallet_id" in (select "id" from "wallets" where "player_id" = ?)',
        [playerId],
      );
      await orm.em.getConnection().execute('delete from "wager_transactions" where "player_id" = ?', [playerId]);
      await orm.em.getConnection().execute('delete from "wallets" where "player_id" = ?', [playerId]);
    }
    if (app) {
      await app.close();
    }
  });

  it('creates a wallet and records a processed OPENING transaction and credit entry', async () => {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } })
      .expect(201);

    expect(response.body).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });

    const transactionId = await orm.em.getConnection().execute<{ id: string }[]>(
      'select "id" from "wager_transactions" where "wallet_id" = ? and "kind" = ?',
      [response.body.id, 'OPENING'],
    );
    const entries = await orm.em.getConnection().execute<
      { direction: string; amount_minor_units: string; balance_before_minor_units: string; balance_after_minor_units: string }[]
    >(
      'select "direction", "amount_minor_units", "balance_before_minor_units", "balance_after_minor_units" from "wallet_ledger_entries" where "wallet_id" = ?',
      [response.body.id],
    );

    expect(transactionId).toHaveLength(1);
    expect(entries).toEqual([
      {
        direction: 'CREDIT',
        amount_minor_units: '100000',
        balance_before_minor_units: '0',
        balance_after_minor_units: '100000',
      },
    ]);

    const linkedEntry = await orm.em.getConnection().execute<{ transaction_id: string }[]>(
      'select "transaction_id" from "wallet_ledger_entries" where "wallet_id" = ?',
      [response.body.id],
    );
    expect(linkedEntry[0]?.transaction_id).toBe(transactionId[0]?.id);
    const events = await orm.em.getConnection().execute(
      'select "event_type", "data" from "integration_event_outbox" where "aggregate_id" = ?',
      [transactionId[0]?.id],
    );
    expect(events.map((event: { event_type: string }) => event.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('creates a zero-balance wallet without an OPENING transaction or ledger entry', async () => {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '0.00', currency: 'BRL' } })
      .expect(201);

    expect(response.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    const rows = await orm.em.getConnection().execute<{ transactions: string; entries: string; events: string }[]>(
      `select
         (select count(*)::text from "wager_transactions" where "wallet_id" = ?) as transactions,
         (select count(*)::text from "wallet_ledger_entries" where "wallet_id" = ?) as entries,
         (select count(*)::text from "integration_event_outbox" where "aggregate_id" in (select "id" from "wager_transactions" where "wallet_id" = ?)) as events`,
      [response.body.id, response.body.id, response.body.id],
    );
    expect(rows[0]).toEqual({ transactions: '0', entries: '0', events: '0' });
  });

  it('returns a wallet by ID with its current balance and version', async () => {
    const created = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '20.00', currency: 'BRL' } })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/wallets/${created.body.id}`)
      .expect(200);

    expect(response.body).toEqual(created.body);
  });

  it('returns not found when requesting a wallet that does not exist', async () => {
    const response = await request(app.getHttpServer())
      .get(`/wallets/${crypto.randomUUID()}`)
      .expect(404);

    expect(response.body.code).toBe('WALLET_NOT_FOUND');
  });

  it('reconciles the stored wallet balance against its immutable ledger', async () => {
    const created = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })
      .expect(201);

    const consistent = await request(app.getHttpServer())
      .post(`/wallets/${created.body.id}/reconciliation`)
      .expect(201);
    expect(consistent.body).toEqual({
      walletId: created.body.id,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });

    await orm.em.getConnection().execute(
      'update "wallets" set "balance_minor_units" = ? where "id" = ?',
      [9_900, created.body.id],
    );
    const inconsistent = await request(app.getHttpServer())
      .post(`/wallets/${created.body.id}/reconciliation`)
      .expect(201);
    expect(inconsistent.body).toEqual({
      walletId: created.body.id,
      storedBalance: { amount: '99.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '-1.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
    });
  });

  it('returns not found when reconciling a wallet that does not exist', async () => {
    const response = await request(app.getHttpServer())
      .post(`/wallets/${crypto.randomUUID()}/reconciliation`)
      .expect(404);

    expect(response.body.code).toBe('WALLET_NOT_FOUND');
  });

  it('allows one wallet per currency and reports a duplicate as a conflict', async () => {
    await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '0.00', currency: 'BRL' } })
      .expect(201);
    await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '0.00', currency: 'USD' } })
      .expect(201);

    const duplicate = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } })
      .expect(409);
    expect(duplicate.body.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it('rejects invalid decimal money input', async () => {
    await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: 100, currency: 'BRL' } })
      .expect(400);
  });
});
