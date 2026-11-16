import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Money } from '../src/domain/money/money.js';
import { InsufficientWalletFundsError, Wallet } from '../src/domain/wallet/wallet.js';
import { LedgerDirection, WalletLedgerEntry } from '../src/domain/ledger/ledger-entry.js';
import {
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/domain/wager-transaction/wager-transaction.js';
import mikroOrmConfig from '../src/infrastructure/database/mikro-orm.config.js';
import { MikroOrmWalletRepository } from '../src/infrastructure/persistence/mikro-orm-wallet.repository.js';
import { MikroOrmWalletLedgerRepository } from '../src/infrastructure/persistence/mikro-orm-wallet-ledger.repository.js';
import { MikroOrmWalletUnitOfWork } from '../src/infrastructure/persistence/mikro-orm-wallet-unit-of-work.js';
import { MikroOrmWagerTransactionRepository } from '../src/infrastructure/persistence/mikro-orm-wager-transaction.repository.js';
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
      await orm.em.getConnection().execute(
        'delete from "integration_event_outbox" where "aggregate_id" in (select "id" from "wager_transactions" where "player_id" like ?)',
        [`${playerId}%`],
      );
      await orm.em.getConnection().execute(
        'delete from "wallet_ledger_entries" where "wallet_id" in (select "id" from "wallets" where "player_id" like ?)',
        [`${playerId}%`],
      );
      await orm.em.getConnection().execute('delete from "wager_transactions" where "player_id" like ?', [`${playerId}%`]);
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

    const transactions = [80, 80].map((amount, index) =>
      WagerTransaction.create({
        id: crypto.randomUUID(),
        providerId: 'test-provider',
        externalTransactionId: `race-${crypto.randomUUID()}`,
        idempotencyKey: `race-${crypto.randomUUID()}`,
        payloadHash: 'race-payload',
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'race-round',
        gameId: 'race-game',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: `${amount}.00`, currency: 'BRL' }),
        createdAt: new Date(`2026-11-16T12:0${index}:00.000Z`),
      }),
    );
    const transactionRepository = new MikroOrmWagerTransactionRepository(orm.em.fork());
    await Promise.all(transactions.map((transaction) => transactionRepository.save(transaction)));

    const results = await Promise.allSettled([
      movementService.debit(transactions[0]!.id),
      movementService.debit(transactions[1]!.id),
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

    const ledger = new MikroOrmWalletLedgerRepository(orm.em.fork());
    const entries = await Promise.all(
      transactions.map((transaction) => ledger.findByWalletAndTransactionId(wallet.id, transaction.id)),
    );
    const persistedEntry = entries.find((entry) => entry !== null);
    expect(entries.filter((entry) => entry !== null)).toHaveLength(1);
    expect(persistedEntry?.money.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(persistedEntry?.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(persistedEntry?.balanceAfter.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });

    const storedTransactions = await Promise.all(
      transactions.map((transaction) =>
        new MikroOrmWagerTransactionRepository(orm.em.fork()).findById(transaction.id),
      ),
    );
    expect(storedTransactions.filter((transaction) => transaction?.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    const rejectedTransaction = storedTransactions.find((transaction) => transaction?.status === WagerTransactionStatus.Rejected);
    expect(rejectedTransaction?.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('credits a WIN and does not allow provider movement handling to process OPENING', async () => {
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `${playerId}-win`,
      initialBalance: Money.zero('BRL'),
    });
    await new MikroOrmWalletRepository(orm.em.fork()).save(wallet);

    const win = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'test-provider',
      externalTransactionId: `win-${crypto.randomUUID()}`,
      idempotencyKey: `win-${crypto.randomUUID()}`,
      payloadHash: 'win-payload',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'win-round',
      gameId: 'win-game',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '12.50', currency: 'BRL' }),
      createdAt: new Date('2026-11-16T12:00:00.000Z'),
    });
    const opening = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'test-provider',
      externalTransactionId: `opening-${crypto.randomUUID()}`,
      idempotencyKey: `opening-${crypto.randomUUID()}`,
      payloadHash: 'opening-payload',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'opening-round',
      gameId: 'opening-game',
      kind: WagerTransactionKind.Opening,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt: new Date('2026-11-16T12:00:00.000Z'),
    });
    const transactionRepository = new MikroOrmWagerTransactionRepository(orm.em.fork());
    await transactionRepository.save(win);
    await transactionRepository.save(opening);

    const change = await movementService.credit(win.id);
    expect(change.balanceAfter.toJSON()).toEqual({ amount: '12.50', currency: 'BRL' });
    let openingRejected = false;
    try {
      await movementService.credit(opening.id);
    } catch (error) {
      openingRejected = error instanceof InvalidWagerTransactionError;
    }
    expect(openingRejected).toBe(true);

    const persistedWallet = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    const persistedWin = await new MikroOrmWagerTransactionRepository(orm.em.fork()).findById(win.id);
    const persistedOpening = await new MikroOrmWagerTransactionRepository(orm.em.fork()).findById(opening.id);
    const winEntry = await new MikroOrmWalletLedgerRepository(orm.em.fork()).findByWalletAndTransactionId(
      wallet.id,
      win.id,
    );

    expect(persistedWallet?.balance.toJSON()).toEqual({ amount: '12.50', currency: 'BRL' });
    expect(persistedWin?.status).toBe(WagerTransactionStatus.Processed);
    expect(persistedOpening?.status).toBe(WagerTransactionStatus.Pending);
    expect(winEntry?.direction).toBe(LedgerDirection.Credit);
  });

  it('rolls back the wallet update when the ledger rejects a duplicate transaction', async () => {
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `${playerId}-duplicate`,
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });
    await new MikroOrmWalletRepository(orm.em.fork()).save(wallet);
    const transaction = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'test-provider',
      externalTransactionId: `duplicate-${crypto.randomUUID()}`,
      idempotencyKey: `duplicate-${crypto.randomUUID()}`,
      payloadHash: 'duplicate-payload',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'duplicate-round',
      gameId: 'duplicate-game',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt: new Date('2026-11-16T12:00:00.000Z'),
    });
    await new MikroOrmWagerTransactionRepository(orm.em.fork()).save(transaction);

    const existingEntry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '50.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '40.00', currency: 'BRL' }),
      createdAt: new Date('2026-11-16T12:01:00.000Z'),
    });
    await new MikroOrmWalletLedgerRepository(orm.em.fork()).save(existingEntry);

    let rejected = false;
    try {
      await movementService.debit(transaction.id);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    const persisted = await new MikroOrmWalletRepository(orm.em.fork()).findById(wallet.id);
    const entry = await new MikroOrmWalletLedgerRepository(orm.em.fork()).findByWalletAndTransactionId(wallet.id, transaction.id);
    const persistedTransaction = await new MikroOrmWagerTransactionRepository(orm.em.fork()).findById(transaction.id);
    expect(persisted?.balance.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });
    expect(persisted?.version).toBe(1);
    expect(entry?.money.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(persistedTransaction?.status).toBe(WagerTransactionStatus.Pending);
  });
});
