import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../src/domain/wager-transaction/wager-transaction.js';
import { Money } from '../src/domain/money/money.js';
import { Wallet } from '../src/domain/wallet/wallet.js';
import mikroOrmConfig from '../src/infrastructure/database/mikro-orm.config.js';
import { MikroOrmWalletRepository } from '../src/infrastructure/persistence/mikro-orm-wallet.repository.js';
import { MikroOrmWalletUnitOfWork } from '../src/infrastructure/persistence/mikro-orm-wallet-unit-of-work.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  RegisterWagerTransactionService,
} from '../src/application/register-wager-transaction.service.js';

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }

  return undefined;
}

describe('wager transaction registration', () => {
  let orm: MikroORM;
  let service: RegisterWagerTransactionService;
  let wallet: Wallet;
  const providerId = `registration-provider-${crypto.randomUUID()}`;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
    wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: `registration-player-${crypto.randomUUID()}`,
      initialBalance: Money.zero('BRL'),
    });
    await new MikroOrmWalletRepository(orm.em.fork()).save(wallet);
    service = new RegisterWagerTransactionService(new MikroOrmWalletUnitOfWork(orm.em));
  });

  afterAll(async () => {
    if (orm && wallet) {
      await orm.em.getConnection().execute('delete from "wallet_ledger_entries" where "wallet_id" = ?', [wallet.id]);
      await orm.em.getConnection().execute('delete from "wager_transactions" where "wallet_id" = ?', [wallet.id]);
      await orm.em.getConnection().execute('delete from "wallets" where "id" = ?', [wallet.id]);
      await orm.close(true);
    }
  });

  function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
    return {
      id: crypto.randomUUID(),
      providerId,
      externalTransactionId: `external-${crypto.randomUUID()}`,
      idempotencyKey: `idempotency-${crypto.randomUUID()}`,
      payloadHash: 'stable-payload-hash',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
      createdAt: new Date('2026-11-16T12:00:00.000Z'),
      ...overrides,
    };
  }

  it('returns the original transaction for an identical retry', async () => {
    const input = props();
    const first = await service.register(input);
    const retry = await service.register({ ...input, id: crypto.randomUUID() });

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.transaction.id).toBe(first.transaction.id);
    expect(retry.transaction.status).toBe(first.transaction.status);
  });

  it('rejects reusing an idempotency key with a different payload', async () => {
    const input = props();
    await service.register(input);

    const error = await captureError(
      service.register({ ...input, id: crypto.randomUUID(), payloadHash: 'different-payload-hash' }),
    );
    expect(error).toBeInstanceOf(IdempotencyConflictError);
  });

  it('rejects reusing a provider transaction ID with a different idempotency key', async () => {
    const input = props();
    await service.register(input);

    const error = await captureError(
      service.register({
        ...input,
        id: crypto.randomUUID(),
        idempotencyKey: `different-${crypto.randomUUID()}`,
      }),
    );
    expect(error).toBeInstanceOf(ExternalTransactionConflictError);
  });

  it('resolves simultaneous identical registrations to the same stored transaction', async () => {
    const input = props();
    const results = await Promise.all([service.register(input), service.register(input)]);

    expect(results[0]?.transaction.id).toBe(results[1]?.transaction.id);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);

    const rows = await orm.em.getConnection().execute<{ count: string }[]>(
      'select count(*)::text as count from "wager_transactions" where "provider_id" = ? and "idempotency_key" = ?',
      [input.providerId, input.idempotencyKey],
    );
    expect(rows[0]?.count).toBe('1');
  });
});
