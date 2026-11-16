import { describe, expect, it } from 'bun:test';
import type { EntityManager } from '@mikro-orm/core';
import { MikroOrmWalletUnitOfWork } from '../src/infrastructure/persistence/mikro-orm-wallet-unit-of-work.js';
import { MetricsRegistry } from '../src/infrastructure/metrics/metrics.registry.js';

describe('wallet unit of work metrics', () => {
  it('counts PostgreSQL deadlocks and lock-unavailable failures', async () => {
    const metrics = new MetricsRegistry();
    const em = {
      transactional: async () => {
        throw { code: '40P01' };
      },
    } as unknown as EntityManager;
    const unitOfWork = new MikroOrmWalletUnitOfWork(em, metrics);

    const error = await unitOfWork
      .execute(async () => undefined)
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ code: '40P01' });
    expect(metrics.renderPrometheus()).toContain(
      'wallet_lock_conflicts_total 1',
    );
  });
});
