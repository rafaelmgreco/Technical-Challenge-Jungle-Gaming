import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import mikroOrmConfig from '../src/infrastructure/database/mikro-orm.config.js';

async function expectConstraintViolation(operation: Promise<unknown>): Promise<void> {
  let wasRejected = false;

  try {
    await operation;
  } catch {
    wasRejected = true;
  }

  expect(wasRejected).toBe(true);
}

describe('wallet database migration', () => {
  let orm: MikroORM;
  const playerId = `migration-test-${crypto.randomUUID()}`;
  const walletId = crypto.randomUUID();
  const ledgerTestPlayerId = `${playerId}-ledger`;
  const ledgerTestWalletId = crypto.randomUUID();
  const ledgerTestTransactionId = crypto.randomUUID();

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
    await orm.em.getConnection().execute(
      `insert into "wallets" ("id", "player_id", "currency", "balance_minor_units", "version", "created_at", "updated_at")
       values (?, ?, ?, ?, ?, now(), now())`,
      [ledgerTestWalletId, ledgerTestPlayerId, 'BRL', '0', 1],
    );
    await orm.em.getConnection().execute(
      `insert into "wager_transactions" ("id", "provider_id", "external_transaction_id", "idempotency_key", "payload_hash", "wallet_id", "player_id", "round_id", "game_id", "kind", "amount_minor_units", "currency", "created_at", "status")
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ?)`,
      [ledgerTestTransactionId, 'migration-provider', 'migration-external', 'migration-key', 'migration-hash', ledgerTestWalletId, ledgerTestPlayerId, 'migration-round', 'migration-game', 'BET', '100', 'BRL', 'PENDING'],
    );
  });

  afterAll(async () => {
    if (orm) {
      await orm.em.getConnection().execute('delete from "wager_transactions" where "player_id" like ?', [`${playerId}%`]);
      await orm.em.getConnection().execute('delete from "wallets" where "player_id" like ?', [`${playerId}%`]);
      await orm.close(true);
    }
  });

  it('stores wallet balances as bigint minor units and accepts multiple currencies', async () => {
    await orm.em.getConnection().execute(
      `insert into "wallets" ("id", "player_id", "currency", "balance_minor_units", "version", "created_at", "updated_at")
       values (?, ?, ?, ?, ?, now(), now()), (?, ?, ?, ?, ?, now(), now())`,
      [walletId, playerId, 'BRL', '1250', 1, crypto.randomUUID(), playerId, 'USD', '0', 1],
    );

    const rows = await orm.em.getConnection().execute<{ currency: string; balance_minor_units: string }[]>(
      'select "currency", "balance_minor_units" from "wallets" where "player_id" = ? order by "currency"',
      [playerId],
    );

    expect(rows).toEqual([
      { currency: 'BRL', balance_minor_units: '1250' },
      { currency: 'USD', balance_minor_units: '0' },
    ]);
  });

  it('rejects ledger entries with a different wallet currency or an unbalanced movement', async () => {
    const insertLedgerEntry = (currency: string, balanceAfter: string) =>
      orm.em.getConnection().execute(
        `insert into "wallet_ledger_entries" ("id", "wallet_id", "transaction_id", "direction", "currency", "amount_minor_units", "balance_before_minor_units", "balance_after_minor_units", "created_at")
         values (?, ?, ?, ?, ?, ?, ?, ?, now())`,
        [crypto.randomUUID(), ledgerTestWalletId, ledgerTestTransactionId, 'DEBIT', currency, '100', '1000', balanceAfter],
      );

    await expectConstraintViolation(insertLedgerEntry('USD', '900'));
    await expectConstraintViolation(insertLedgerEntry('BRL', '899'));
  });

  it('rejects a second wallet for the same player and currency', async () => {
    await expectConstraintViolation(
      orm.em.getConnection().execute(
        `insert into "wallets" ("id", "player_id", "currency", "balance_minor_units", "created_at", "updated_at")
         values (?, ?, ?, ?, now(), now())`,
        [crypto.randomUUID(), playerId, 'BRL', '0'],
      ),
    );
  });

  it('rejects invalid currency codes, negative balances, and non-positive versions', async () => {
    const connection = orm.em.getConnection();
    const insert = (id: string, currency: string, balance: string, version: number) =>
      connection.execute(
        `insert into "wallets" ("id", "player_id", "currency", "balance_minor_units", "version", "created_at", "updated_at")
         values (?, ?, ?, ?, ?, now(), now())`,
        [id, `${playerId}-${id}`, currency, balance, version],
      );

    await expectConstraintViolation(insert(crypto.randomUUID(), 'brl', '0', 1));
    await expectConstraintViolation(insert(crypto.randomUUID(), 'BRL', '-1', 1));
    await expectConstraintViolation(insert(crypto.randomUUID(), 'BRL', '0', 0));
  });
});
