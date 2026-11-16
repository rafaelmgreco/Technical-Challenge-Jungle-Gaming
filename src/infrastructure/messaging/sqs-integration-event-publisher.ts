import { Injectable } from '@nestjs/common';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { IntegrationEventPublisher } from '../../application/ports/integration-event-publisher.js';
import type { IntegrationEventRecord } from '../../application/ports/integration-event-outbox.repository.js';
import { serializeIntegrationEvent } from './integration-event-envelope.js';

@Injectable()
export class SqsIntegrationEventPublisher implements IntegrationEventPublisher {
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

  async publish(event: IntegrationEventRecord): Promise<void> {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error(
        'SQS_QUEUE_URL is required to publish integration events',
      );
    }

    const walletId = event.data.walletId;
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: serializeIntegrationEvent(event),
      ...(queueUrl.endsWith('.fifo')
        ? {
            MessageGroupId:
              typeof walletId === 'string' ? walletId : event.aggregateId,
            MessageDeduplicationId: event.id,
          }
        : {}),
    });
    await this.client.send(command);
  }
}
