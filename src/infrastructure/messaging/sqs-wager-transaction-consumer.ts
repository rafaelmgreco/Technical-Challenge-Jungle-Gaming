import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from '../../application/register-wager-transaction.service.js';
import { InboxMessageConflictError } from '../../application/ports/inbox-message.repository.js';
import { SubmitWagerTransactionService } from '../../application/submit-wager-transaction.service.js';
import { parseWagerTransactionBody } from '../../wagering/parse-wager-transaction-body.js';
import {
  StructuredLogger,
  type StructuredLogContext,
} from '../logging/structured-logger.js';

const CONSUMER_NAME = 'wager-transaction-requested-v1';

@Injectable()
export class SqsWagerTransactionConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new StructuredLogger();
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(process.env.SQS_ENDPOINT_URL
      ? { endpoint: process.env.SQS_ENDPOINT_URL }
      : {}),
    ...(process.env.SQS_ENDPOINT_URL
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  });
  private stopped = true;
  private loop?: Promise<void>;

  constructor(private readonly submissions: SubmitWagerTransactionService) {}

  onModuleInit(): void {
    if (
      process.env.NODE_ENV === 'test' ||
      !process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL
    )
      return;
    this.stopped = false;
    this.loop = this.consumeContinuously();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.loop;
    this.client.destroy();
  }

  async runOnce(waitTimeSeconds = 20, visibilityTimeoutSeconds = 30): Promise<number> {
    const queueUrl = process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;
    if (!queueUrl)
      throw new Error(
        'SQS_WAGER_TRANSACTIONS_QUEUE_URL is required to consume wager transactions',
      );

    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitTimeSeconds,
      VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
    let acknowledged = 0;
    for (const message of response.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) continue;
      let logContext: StructuredLogContext = {};
      if (message.MessageId) logContext.messageId = message.MessageId;
      try {
        const envelope = JSON.parse(message.Body) as Record<string, unknown>;
        if (envelope.type !== 'WagerTransactionRequested') {
          throw new Error('Unsupported SQS wager message type');
        }
        if (
          typeof envelope.messageId !== 'string' ||
          envelope.messageId.trim().length === 0
        ) {
          throw new Error('SQS wager message must contain a messageId');
        }
        if (
          envelope.data === null ||
          typeof envelope.data !== 'object' ||
          Array.isArray(envelope.data)
        ) {
          throw new Error('SQS wager message data must be an object');
        }
        const data = envelope.data as Record<string, unknown>;
        if (
          typeof data.idempotencyKey !== 'string' ||
          data.idempotencyKey.trim().length === 0
        ) {
          throw new Error(
            'SQS wager message data must contain an idempotencyKey',
          );
        }
        const input = parseWagerTransactionBody(data);
        logContext = {
          messageId: envelope.messageId,
          correlationId: data.idempotencyKey.trim(),
          externalTransactionId: input.externalTransactionId,
          walletId: input.walletId,
          providerId: input.providerId,
        };
        const payloadHash = createHash('sha256')
          .update(message.Body)
          .digest('hex');
        const result = await this.submissions.submit(
          { ...input, idempotencyKey: data.idempotencyKey.trim() },
          {
            consumerName: CONSUMER_NAME,
            messageId: envelope.messageId,
            payloadHash,
            receivedAt: new Date(),
          },
        );
        this.logger.info('wager_transaction_message_processed', {
          ...logContext,
          ...(result.transactionId
            ? { transactionId: result.transactionId }
            : {}),
        });
        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
        acknowledged += 1;
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof ExternalTransactionConflictError ||
          error instanceof InboxMessageConflictError
        ) {
          this.logger.warn(
            'wager_transaction_message_terminal',
            logContext,
            error,
          );
          await this.client.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
          acknowledged += 1;
          continue;
        }
        this.logger.error('wager_transaction_message_failed', logContext, error);
      }
    }
    return acknowledged;
  }

  private async consumeContinuously(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (error) {
        if (!this.stopped) {
          this.logger.error('sqs_wager_transaction_poll_failed', {}, error);
        }
      }
    }
  }
}
