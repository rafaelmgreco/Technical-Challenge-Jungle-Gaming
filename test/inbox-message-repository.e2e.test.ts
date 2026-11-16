import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  InboxMessageConflictError,
  type InboxMessageRecord,
} from '../src/application/ports/inbox-message.repository.js';
import mikroOrmConfig from '../src/infrastructure/database/mikro-orm.config.js';
import { MikroOrmInboxMessageRepository } from '../src/infrastructure/persistence/mikro-orm-inbox-message.repository.js';
import { MikroOrmWalletUnitOfWork } from '../src/infrastructure/persistence/mikro-orm-wallet-unit-of-work.js';

describe('MikroORM inbox message repository', () => {
  let orm: MikroORM;
  const consumerName = `inbox-test-${crypto.randomUUID()}`;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
  });

  afterAll(async () => {
    if (!orm) return;
    await orm.em
      .getConnection()
      .execute('delete from "inbox_messages" where "consumer_name" = ?', [
        consumerName,
      ]);
    await orm.close(true);
  });

  it('persists completed message IDs and treats identical redeliveries as duplicates', async () => {
    const repository = new MikroOrmInboxMessageRepository(orm.em.fork());
    const receivedAt = new Date();
    const message: InboxMessageRecord = {
      consumerName,
      messageId: crypto.randomUUID(),
      payloadHash: 'stable-payload-hash',
      receivedAt,
      processedAt: new Date(receivedAt.getTime() + 10),
    };

    expect(await repository.recordProcessed(message)).toBe(true);
    expect(
      await repository.recordProcessed({ ...message, receivedAt: new Date() }),
    ).toBe(false);
    expect(await repository.find(consumerName, message.messageId)).toEqual(
      message,
    );
    expect(
      repository.recordProcessed({
        ...message,
        payloadHash: 'different-payload-hash',
      }),
    ).rejects.toBeInstanceOf(InboxMessageConflictError);
  });

  it('rolls back an inbox record with its enclosing unit of work', async () => {
    const message: InboxMessageRecord = {
      consumerName,
      messageId: crypto.randomUUID(),
      payloadHash: 'rolled-back-payload',
      receivedAt: new Date(),
      processedAt: new Date(),
    };
    const unitOfWork = new MikroOrmWalletUnitOfWork(orm.em);

    try {
      await unitOfWork.execute(async ({ inbox }) => {
        await inbox.recordProcessed(message);
        throw new Error('force the unit of work to roll back');
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }

    expect(
      await new MikroOrmInboxMessageRepository(orm.em.fork()).find(
        consumerName,
        message.messageId,
      ),
    ).toBeNull();
  });
});
