import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, it } from 'bun:test';
import { SqsIntegrationEventPublisher } from '../src/infrastructure/messaging/sqs-integration-event-publisher.js';

const endpoint = process.env.SQS_ENDPOINT_URL ?? '';
const queueUrl = process.env.SQS_QUEUE_URL ?? '';
const enabled = Boolean(endpoint && queueUrl);

describe.skipIf(!enabled)('SQS integration event publisher', () => {
  const client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  afterAll(() => client.destroy());

  it('sends an integration event to the configured queue', async () => {
    const event = {
      id: crypto.randomUUID(),
      aggregateId: crypto.randomUUID(),
      eventType: 'WagerTransactionRejected' as const,
      version: 1 as const,
      correlationId: crypto.randomUUID(),
      occurredAt: new Date(),
      data: { walletId: crypto.randomUUID(), failureCode: 'INVALID_REFERENCE' },
      attempts: 3,
    };

    await new SqsIntegrationEventPublisher().publish(event);

    let received = false;
    for (let attempt = 0; attempt < 10 && !received; attempt += 1) {
      const result = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );
      const message = result.Messages?.[0];
      if (message?.Body && message.ReceiptHandle) {
        expect(JSON.parse(message.Body)).toEqual({
          id: event.id,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          version: event.version,
          correlationId: event.correlationId,
          occurredAt: event.occurredAt.toISOString(),
          data: event.data,
        });
        expect(JSON.parse(message.Body)).not.toHaveProperty('attempts');
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
        received = true;
      }
    }

    expect(received).toBeDefined();
  });
});
