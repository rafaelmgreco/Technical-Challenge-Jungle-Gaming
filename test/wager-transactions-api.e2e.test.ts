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
import { PendingReferenceWorker } from '../src/application/pending-reference.worker.js';

describe('WagerTransactionsController (e2e)', () => {
  let app: INestApplication<App>;
  let orm: MikroORM;
  let wallet: Wallet;
  let anotherWallet: Wallet;

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
    anotherWallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `http-provider-test-${crypto.randomUUID()}`,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    await new MikroOrmWalletRepository(orm.em.fork()).save(anotherWallet);
  });

  afterEach(async () => {
    if (orm && wallet && anotherWallet) {
      for (const fixtureWallet of [wallet, anotherWallet]) {
        await orm.em.getConnection().execute(
          'delete from "integration_event_outbox" where "aggregate_id" in (select "id" from "wager_transactions" where "wallet_id" = ?)',
          [fixtureWallet.id],
        );
        await orm.em.getConnection().execute(
          'delete from "wallet_ledger_entries" where "wallet_id" = ?',
          [fixtureWallet.id],
        );
        await orm.em.getConnection().execute(
          'delete from "wager_transactions" where "wallet_id" = ?',
          [fixtureWallet.id],
        );
        await orm.em.getConnection().execute(
          'delete from "wallets" where "id" = ?',
          [fixtureWallet.id],
        );
      }
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
    const events = await orm.em.getConnection().execute(
      'select "event_type", "data" from "integration_event_outbox" where "aggregate_id" = ? order by "event_type"',
      [first.body.transactionId],
    );
    expect(events.map((event: { event_type: string }) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(events.find((event: { event_type: string }) => event.event_type === 'WalletBalanceChanged')?.data).toMatchObject({
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
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

  it('retrieves a wager transaction by internal ID and provider transaction ID', async () => {
    const submitted = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:lookup-transaction')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'lookup-transaction',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'lookup-round',
        gameId: 'lookup-game',
        kind: 'BET',
        money: { amount: '12.00', currency: 'BRL' },
      })
      .expect(201);

    const byId = await request(app.getHttpServer())
      .get(`/wagering/transactions/${submitted.body.transactionId}`)
      .expect(200);
    const byProviderExternalId = await request(app.getHttpServer())
      .get('/providers/http-provider/wagering/transactions/lookup-transaction')
      .expect(200);

    expect(byId.body).toEqual(byProviderExternalId.body);
    expect(byId.body).toMatchObject({
      transactionId: submitted.body.transactionId,
      providerId: 'http-provider',
      externalTransactionId: 'lookup-transaction',
      status: 'PROCESSED',
      money: { amount: '12.00', currency: 'BRL' },
      balance: { amount: '88.00', currency: 'BRL' },
    });
  });

  it('applies 50 concurrent identical submissions as a single wallet debit', async () => {
    const externalTransactionId = `concurrent-50-${crypto.randomUUID()}`;
    const idempotencyKey = `http-provider:${externalTransactionId}`;
    const body = {
      providerId: 'http-provider',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'concurrent-50-round',
      gameId: 'concurrent-50-game',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    };

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set('Idempotency-Key', idempotencyKey)
          .send(body),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(49);
    expect(responses.every((response) => response.body.status === 'PROCESSED')).toBe(true);
    expect(
      new Set(responses.map((response) => response.body.transactionId)).size,
    ).toBe(1);

    const persistedWallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(wallet.id);
    const transactionRows = await orm.em.getConnection().execute(
      'select count(*)::int as count from "wager_transactions" where "provider_id" = ? and "external_transaction_id" = ?',
      ['http-provider', externalTransactionId],
    );
    const ledgerRows = await orm.em.getConnection().execute(
      'select count(*)::int as count from "wallet_ledger_entries" where "wallet_id" = ? and "transaction_id" = ?',
      [wallet.id, responses[0]?.body.transactionId],
    );
    expect(persistedWallet?.balance.toJSON()).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });
    expect(transactionRows[0].count).toBe(1);
    expect(ledgerRows[0].count).toBe(1);
  });

  it('processes concurrent submissions for different wallets independently', async () => {
    const submissions = [
      {
        wallet: wallet,
        externalTransactionId: `independent-wallet-a-${crypto.randomUUID()}`,
        amount: '20.00',
      },
      {
        wallet: anotherWallet,
        externalTransactionId: `independent-wallet-b-${crypto.randomUUID()}`,
        amount: '35.00',
      },
    ];

    const responses = await Promise.all(
      submissions.map(({ wallet: targetWallet, externalTransactionId, amount }) =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set('Idempotency-Key', `http-provider:${externalTransactionId}`)
          .send({
            providerId: 'http-provider',
            externalTransactionId,
            playerId: targetWallet.playerId,
            walletId: targetWallet.id,
            roundId: `round-${externalTransactionId}`,
            gameId: 'independent-wallet-game',
            kind: 'BET',
            money: { amount, currency: 'BRL' },
          }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.map((response) => response.body.status)).toEqual([
      'PROCESSED',
      'PROCESSED',
    ]);
    expect(responses[0]?.body.balance).toEqual({
      amount: '80.00',
      currency: 'BRL',
    });
    expect(responses[1]?.body.balance).toEqual({
      amount: '65.00',
      currency: 'BRL',
    });

    const balances = await Promise.all(
      submissions.map(({ wallet: targetWallet }) =>
        new MikroOrmWalletRepository(orm.em.fork()).findById(targetWallet.id),
      ),
    );
    expect(balances.map((persistedWallet) => persistedWallet?.balance.toJSON())).toEqual([
      { amount: '80.00', currency: 'BRL' },
      { amount: '65.00', currency: 'BRL' },
    ]);
    const ledgerRows = await Promise.all(
      submissions.map(({ wallet: targetWallet }) =>
        orm.em.getConnection().execute(
          'select count(*)::int as count from "wallet_ledger_entries" where "wallet_id" = ?',
          [targetWallet.id],
        ),
      ),
    );
    expect(ledgerRows.map((rows) => rows[0].count)).toEqual([1, 1]);
  });

  it('returns not found for unknown transaction lookup keys', async () => {
    const byId = await request(app.getHttpServer())
      .get(`/wagering/transactions/${crypto.randomUUID()}`)
      .expect(404);
    expect(byId.body.code).toBe('WAGER_TRANSACTION_NOT_FOUND');

    const byProviderExternalId = await request(app.getHttpServer())
      .get('/providers/http-provider/wagering/transactions/unknown-transaction')
      .expect(404);
    expect(byProviderExternalId.body.code).toBe('WAGER_TRANSACTION_NOT_FOUND');
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

  it('processes a referenced WIN against a processed BET with a different amount', async () => {
    const bet = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:reference-bet-1')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'reference-bet-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'reference-round-1',
        gameId: 'reference-game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      })
      .expect(201);

    const winBody = {
      providerId: 'http-provider',
      externalTransactionId: 'reference-win-1',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'reference-round-1',
      gameId: 'reference-game-1',
      kind: 'WIN',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'reference-bet-1',
    };
    const key = 'http-provider:reference-win-1';

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(winBody)
      .expect(201);

    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '85.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const retry = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(winBody)
      .expect(200);
    expect(retry.body).toEqual({ ...first.body, idempotentReplay: true });

    const storedReference = await orm.em.getConnection().execute(
      'select "reference_transaction_id" from "wager_transactions" where "id" = ?',
      [first.body.transactionId],
    );
    const betRow = await orm.em.getConnection().execute(
      'select "id" from "wager_transactions" where "external_transaction_id" = ?',
      ['reference-bet-1'],
    );
    expect(storedReference[0].reference_transaction_id).toBe(betRow[0].id);
    expect(bet.body.status).toBe('PROCESSED');
  });

  it('stores an unavailable WIN reference as pending and returns the same pending result on retry', async () => {
    const body = {
      providerId: 'http-provider',
      externalTransactionId: 'reference-win-missing',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'missing-reference-round',
      gameId: 'missing-reference-game',
      kind: 'WIN',
      money: { amount: '5.00', currency: 'BRL' },
      referenceExternalTransactionId: 'unknown-bet',
    };
    const key = 'http-provider:reference-win-missing';

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(202);
    expect(first.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      referenceExternalTransactionId: 'unknown-bet',
      idempotentReplay: false,
    });
    const pendingEvent = await orm.em.getConnection().execute(
      'select "event_type", "data" from "integration_event_outbox" where "aggregate_id" = ?',
      [first.body.transactionId],
    );
    expect(pendingEvent).toHaveLength(1);
    expect(pendingEvent[0].event_type).toBe('WagerTransactionPendingReference');
    expect(pendingEvent[0].data.referenceExternalTransactionId).toBe('unknown-bet');

    const retry = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(202);
    expect(retry.body).toMatchObject({
      transactionId: first.body.transactionId,
      status: 'PENDING_REFERENCE',
      referenceExternalTransactionId: 'unknown-bet',
      idempotentReplay: true,
    });
    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    const pendingLedger = await orm.em.getConnection().execute(
      'select count(*)::int as count from "wallet_ledger_entries" where "transaction_id" = ?',
      [first.body.transactionId],
    );
    expect(pendingLedger[0].count).toBe(0);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:unknown-bet')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'unknown-bet',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'missing-reference-round',
        gameId: 'missing-reference-game',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      })
      .expect(201);

    const resolved = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    expect(resolved.body).toMatchObject({
      transactionId: first.body.transactionId,
      status: 'PROCESSED',
      balance: { amount: '80.00', currency: 'BRL' },
      idempotentReplay: true,
    });
  });

  it('reprocesses a due pending WIN after its BET arrives', async () => {
    const pending = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:worker-pending-win')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'worker-pending-win',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'worker-reference-round',
        gameId: 'worker-reference-game',
        kind: 'WIN',
        money: { amount: '5.00', currency: 'BRL' },
        referenceExternalTransactionId: 'worker-reference-bet',
      })
      .expect(202);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:worker-reference-bet')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'worker-reference-bet',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'worker-reference-round',
        gameId: 'worker-reference-game',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      })
      .expect(201);

    const attempted = await app.get(PendingReferenceWorker).runOnce(new Date(Date.now() + 60_000));
    expect(attempted).toBe(1);
    const transaction = await orm.em.getConnection().execute(
      'select "status", "reference_transaction_id" from "wager_transactions" where "id" = ?',
      [pending.body.transactionId],
    );
    expect(transaction[0].status).toBe('PROCESSED');
    expect(transaction[0].reference_transaction_id).toBeTruthy();
    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
  });

  it('backs off pending reference retries and rejects after the configured attempt limit', async () => {
    const pending = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:worker-expiring-win')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'worker-expiring-win',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'worker-expiring-round',
        gameId: 'worker-expiring-game',
        kind: 'WIN',
        money: { amount: '5.00', currency: 'BRL' },
        referenceExternalTransactionId: 'never-arriving-bet',
      })
      .expect(202);

    const worker = app.get(PendingReferenceWorker);
    let row = await orm.em.getConnection().execute(
      'select "reference_attempt_count", "reference_next_attempt_at" from "wager_transactions" where "id" = ?',
      [pending.body.transactionId],
    );
    expect(row[0].reference_attempt_count).toBe(1);
    const initialNextAttempt = new Date(String(row[0].reference_next_attempt_at));
    expect(Number.isNaN(initialNextAttempt.getTime())).toBe(false);
    expect(await worker.runOnce(new Date(initialNextAttempt.getTime() - 1))).toBe(0);
    let runAt = new Date(initialNextAttempt.getTime() + 1);

    for (const expectedAttempt of [2, 3, 4, 5]) {
      expect(await worker.runOnce(runAt)).toBe(1);
      row = await orm.em.getConnection().execute(
        'select "status", "failure_code", "reference_attempt_count", "reference_next_attempt_at" from "wager_transactions" where "id" = ?',
        [pending.body.transactionId],
      );
      expect(row[0].reference_attempt_count).toBe(expectedAttempt);
      if (expectedAttempt < 5) {
        expect(row[0].status).toBe('PENDING_REFERENCE');
        const nextAttempt = new Date(String(row[0].reference_next_attempt_at));
        expect(Number.isNaN(nextAttempt.getTime())).toBe(false);
        expect(nextAttempt.getTime() - runAt.getTime()).toBe(1_000 * 2 ** (expectedAttempt - 1));
        runAt = new Date(nextAttempt.getTime() + 1);
      } else {
        expect(row[0].status).toBe('REJECTED');
        expect(row[0].failure_code).toBe('REFERENCE_NOT_FOUND');
        expect(row[0].reference_next_attempt_at).toBeNull();
      }
    }

    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    const events = await orm.em.getConnection().execute(
      'select "event_type", "data" from "integration_event_outbox" where "aggregate_id" = ? order by "occurred_at", "id"',
      [pending.body.transactionId],
    );
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(events[1].data.failureCode).toBe('REFERENCE_NOT_FOUND');
  });

  it('refunds a processed BET once, credits the same amount, and replays idempotently', async () => {
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:refund-bet-1')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'refund-bet-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'refund-round-1',
        gameId: 'refund-game-1',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      })
      .expect(201);

    const refundBody = {
      providerId: 'http-provider',
      externalTransactionId: 'refund-1',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'refund-round-1',
      gameId: 'refund-game-1',
      kind: 'REFUND',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: 'refund-bet-1',
    };
    const refundKey = 'http-provider:refund-1';
    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', refundKey)
      .send(refundBody)
      .expect(201);

    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const retry = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', refundKey)
      .send(refundBody)
      .expect(200);
    expect(retry.body).toEqual({ ...first.body, idempotentReplay: true });

    const duplicateRefund = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:refund-duplicate')
      .send({ ...refundBody, externalTransactionId: 'refund-duplicate' })
      .expect(422);
    expect(duplicateRefund.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });

    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    const refundLedger = await orm.em.getConnection().execute(
      'select count(*)::int as count from "wallet_ledger_entries" where "transaction_id" = ?',
      [first.body.transactionId],
    );
    expect(refundLedger[0].count).toBe(1);
  });

  it('rejects a REFUND whose amount differs from its processed BET', async () => {
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:refund-amount-bet')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'refund-amount-bet',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'refund-amount-round',
        gameId: 'refund-amount-game',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:refund-wrong-amount')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'refund-wrong-amount',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'refund-amount-round',
        gameId: 'refund-amount-game',
        kind: 'REFUND',
        money: { amount: '19.99', currency: 'BRL' },
        referenceExternalTransactionId: 'refund-amount-bet',
      })
      .expect(422);

    expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE' });
    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
  });

  it('serializes concurrent refunds so a processed BET is credited only once', async () => {
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:concurrent-refund-bet')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'concurrent-refund-bet',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'concurrent-refund-round',
        gameId: 'concurrent-refund-game',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      })
      .expect(201);

    const submitRefund = (externalTransactionId: string) =>
      request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', `http-provider:${externalTransactionId}`)
        .send({
          providerId: 'http-provider',
          externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'concurrent-refund-round',
          gameId: 'concurrent-refund-game',
          kind: 'REFUND',
          money: { amount: '40.00', currency: 'BRL' },
          referenceExternalTransactionId: 'concurrent-refund-bet',
        });

    const results = await Promise.all([
      submitRefund('concurrent-refund-a'),
      submitRefund('concurrent-refund-b'),
    ]);
    expect(results.map((result) => result.status).sort((left, right) => left - right)).toEqual([201, 422]);
    expect(results.find((result) => result.status === 422)?.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    const refundCount = await orm.em.getConnection().execute(
      'select count(*)::int as count from "wager_transactions" where "wallet_id" = ? and "kind" = \'REFUND\' and "status" = \'PROCESSED\'',
      [wallet.id],
    );
    expect(refundCount[0].count).toBe(1);
  });

  it('rolls back processed BET, WIN, and REFUND transactions in the opposite direction once', async () => {
    const submit = (externalTransactionId: string, kind: string, amount: string, reference?: string) =>
      request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', `http-provider:${externalTransactionId}`)
        .send({
          providerId: 'http-provider',
          externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'rollback-round',
          gameId: 'rollback-game',
          kind,
          money: { amount, currency: 'BRL' },
          ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
        });

    await submit('rollback-bet', 'BET', '25.00').expect(201);
    const rollbackBet = await submit('rollback-bet-event', 'ROLLBACK', '25.00', 'rollback-bet').expect(201);
    expect(rollbackBet.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const duplicateBetRollback = await submit('rollback-bet-event-duplicate', 'ROLLBACK', '25.00', 'rollback-bet')
      .expect(422);
    expect(duplicateBetRollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    await submit('rollback-win', 'WIN', '5.00').expect(201);
    const rollbackWin = await submit('rollback-win-event', 'ROLLBACK', '5.00', 'rollback-win').expect(201);
    expect(rollbackWin.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    await submit('rollback-refund-bet', 'BET', '10.00').expect(201);
    await submit('rollback-refund', 'REFUND', '10.00', 'rollback-refund-bet').expect(201);
    const rollbackRefund = await submit('rollback-refund-event', 'ROLLBACK', '10.00', 'rollback-refund').expect(201);
    expect(rollbackRefund.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '90.00', currency: 'BRL' });
  });

  it('rejects a rollback that would make the wallet negative with its own failure code', async () => {
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:rollback-insufficient-win')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'rollback-insufficient-win',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rollback-insufficient-round',
        gameId: 'rollback-insufficient-game',
        kind: 'WIN',
        money: { amount: '20.00', currency: 'BRL' },
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:rollback-insufficient-bet')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'rollback-insufficient-bet',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rollback-insufficient-round',
        gameId: 'rollback-insufficient-game',
        kind: 'BET',
        money: { amount: '110.00', currency: 'BRL' },
      })
      .expect(201);

    const body = {
      providerId: 'http-provider',
      externalTransactionId: 'rollback-insufficient-event',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rollback-insufficient-round',
      gameId: 'rollback-insufficient-game',
      kind: 'ROLLBACK',
      money: { amount: '20.00', currency: 'BRL' },
      referenceExternalTransactionId: 'rollback-insufficient-win',
    };
    const key = 'http-provider:rollback-insufficient-event';

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(422);
    expect(first.body).toMatchObject({ status: 'REJECTED', failureCode: 'ROLLBACK_INSUFFICIENT_FUNDS' });

    const retry = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(422);
    expect(retry.body).toMatchObject({
      transactionId: first.body.transactionId,
      status: 'REJECTED',
      failureCode: 'ROLLBACK_INSUFFICIENT_FUNDS',
      idempotentReplay: true,
    });

    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('processes LOSS without changing the balance or creating a ledger entry, and replays the original result', async () => {
    const body = {
      providerId: 'http-provider',
      externalTransactionId: 'http-loss-1',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'http-round-loss',
      gameId: 'http-game-loss',
      kind: 'LOSS',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const key = 'http-provider:http-loss-1';

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:http-win-after-loss')
      .send({
        ...body,
        externalTransactionId: 'http-win-after-loss',
        roundId: 'http-round-win-after-loss',
        kind: 'WIN',
        money: { amount: '10.00', currency: 'BRL' },
      })
      .expect(201);

    const retry = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);

    expect(retry.body).toEqual({
      transactionId: first.body.transactionId,
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: true,
    });

    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '110.00', currency: 'BRL' });
    const lossLedger = await orm.em.getConnection().execute(
      'select count(*)::int as count from "wallet_ledger_entries" where "transaction_id" = ?',
      [first.body.transactionId],
    );
    expect(lossLedger[0].count).toBe(0);
    const lossEvents = await orm.em.getConnection().execute(
      'select "event_type", "data" from "integration_event_outbox" where "aggregate_id" = ?',
      [first.body.transactionId],
    );
    expect(lossEvents).toHaveLength(1);
    expect(lossEvents[0].event_type).toBe('WagerTransactionProcessed');
    expect(lossEvents[0].data.balance).toEqual({ amount: '100.00', currency: 'BRL' });
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
    const rejectionEvent = await orm.em.getConnection().execute(
      'select "event_type", "data" from "integration_event_outbox" where "aggregate_id" = ?',
      [rejected.body.transactionId],
    );
    expect(rejectionEvent).toHaveLength(1);
    expect(rejectionEvent[0].event_type).toBe('WagerTransactionRejected');
    expect(rejectionEvent[0].data.failureCode).toBe('INSUFFICIENT_FUNDS');

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

  it('records HTTP transaction outcomes and processing duration in Prometheus metrics', async () => {
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'http-provider:metrics-bet')
      .send({
        providerId: 'http-provider',
        externalTransactionId: 'metrics-bet',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'metrics-round',
        gameId: 'metrics-game',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    expect(response.text).toContain(
      'wager_transaction_submissions_total{source="http",status="PROCESSED"} 1',
    );
    expect(response.text).toContain('wager_processing_duration_seconds_count 1');
  });
});
