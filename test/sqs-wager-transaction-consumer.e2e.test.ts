import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { RegisterWagerTransactionService } from '../src/application/register-wager-transaction.service.js';
import { SubmitWagerTransactionService } from '../src/application/submit-wager-transaction.service.js';
import { WalletMovementService } from '../src/application/wallet-movement.service.js';
import { Money } from '../src/domain/money/money.js';
import { Wallet } from '../src/domain/wallet/wallet.js';
import { WagerTransactionKind } from '../src/domain/wager-transaction/wager-transaction.js';
import mikroOrmConfig from '../src/infrastructure/database/mikro-orm.config.js';
import { MikroOrmWalletUnitOfWork } from '../src/infrastructure/persistence/mikro-orm-wallet-unit-of-work.js';
import { MikroOrmWalletRepository } from '../src/infrastructure/persistence/mikro-orm-wallet.repository.js';
import { SqsWagerTransactionConsumer } from '../src/infrastructure/messaging/sqs-wager-transaction-consumer.js';

const endpoint = process.env.SQS_ENDPOINT_URL;

describe.skipIf(!endpoint)('SQS wager transaction consumer', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let consumer: SqsWagerTransactionConsumer;
  let queueUrl: string;
  let deadLetterQueueUrl: string;
  const playerId = `sqs-consumer-test-${crypto.randomUUID()}`;
  const messageId = crypto.randomUUID();
  const consumerName = 'wager-transaction-requested-v1';
  const originalQueueUrl = process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;
  let walletId: string;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
    sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
    const suffix = crypto.randomUUID();
    const createdDlq = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-consumer-dlq-${suffix}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
        },
      }),
    );
    deadLetterQueueUrl = createdDlq.QueueUrl!;
    const dlqArn = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetterQueueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const createdQueue = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-consumer-${suffix}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '0',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn.Attributes?.QueueArn,
            maxReceiveCount: '5',
          }),
        },
      }),
    );
    queueUrl = createdQueue.QueueUrl!;
    process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL = queueUrl;

    const unitOfWork = new MikroOrmWalletUnitOfWork(orm.em);
    const submissions = new SubmitWagerTransactionService(
      new RegisterWagerTransactionService(unitOfWork),
      new WalletMovementService(unitOfWork),
      unitOfWork,
    );
    consumer = new SqsWagerTransactionConsumer(submissions);

    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId,
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    walletId = wallet.id;
    await new MikroOrmWalletRepository(orm.em.fork()).save(wallet);
  });

  afterAll(async () => {
    if (consumer) await consumer.onModuleDestroy();
    if (orm) {
      await orm.em
        .getConnection()
        .execute(
          'delete from "inbox_messages" where "consumer_name" = ? and "message_id" = ?',
          [consumerName, messageId],
        );
      await orm.em
        .getConnection()
        .execute(
          'delete from "integration_event_outbox" where "aggregate_id" in (select "id" from "wager_transactions" where "player_id" = ?)',
          [playerId],
        );
      await orm.em
        .getConnection()
        .execute('delete from "wallet_ledger_entries" where "wallet_id" = ?', [
          walletId,
        ]);
      await orm.em
        .getConnection()
        .execute('delete from "wager_transactions" where "player_id" = ?', [
          playerId,
        ]);
      await orm.em
        .getConnection()
        .execute('delete from "wallets" where "player_id" = ?', [playerId]);
      await orm.close(true);
    }
    if (sqs) {
      if (queueUrl)
        await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      if (deadLetterQueueUrl)
        await sqs.send(
          new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }),
        );
      sqs.destroy();
    }
    if (originalQueueUrl === undefined)
      delete process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;
    else process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL = originalQueueUrl;
  });

  it('applies a wager once and records the SQS message before acknowledging redelivery', async () => {
    const body = JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'sqs-test-provider',
        externalTransactionId: `external-${crypto.randomUUID()}`,
        idempotencyKey: `idempotency-${crypto.randomUUID()}`,
        playerId,
        walletId,
        roundId: 'sqs-consumer-round',
        gameId: 'sqs-consumer-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '5.00', currency: 'BRL' },
      },
    });
    for (const deduplicationId of ['delivery-one', 'delivery-two']) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageGroupId: walletId,
          MessageDeduplicationId: deduplicationId,
        }),
      );
    }

    expect(await consumer.runOnce(1)).toBe(2);
    const persistedWallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);
    const ledgerRows = await orm.em
      .getConnection()
      .execute<Array<Record<string, unknown>>>(
        'select "id" from "wallet_ledger_entries" where "wallet_id" = ?',
        [walletId],
      );
    const inboxRows = await orm.em
      .getConnection()
      .execute<Array<Record<string, unknown>>>(
        'select "message_id" from "inbox_messages" where "consumer_name" = ? and "message_id" = ?',
        [consumerName, messageId],
      );

    expect(persistedWallet?.balance.toJSON()).toEqual({
      amount: '5.00',
      currency: 'BRL',
    });
    expect(ledgerRows).toHaveLength(1);
    expect(inboxRows).toHaveLength(1);
  });

  it('sends a poison message to the configured DLQ after five unsuccessful receives', async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: 'not-json',
        MessageGroupId: walletId,
        MessageDeduplicationId: crypto.randomUUID(),
      }),
    );

    let deadLettered = false;
    for (let attempt = 0; attempt < 7 && !deadLettered; attempt += 1) {
      await consumer.runOnce(0, 0);
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: deadLetterQueueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0,
        }),
      );
      const message = response.Messages?.[0];
      if (message?.ReceiptHandle) {
        expect(message.Body).toBe('not-json');
        deadLettered = true;
      }
    }

    expect(deadLettered).toBe(true);
  });
});
