import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import {
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

@Injectable()
export class HealthCheckService implements OnModuleDestroy {
  private readonly sqsClient = new SQSClient({
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

  constructor(private readonly em: EntityManager) {}

  async readiness(): Promise<{ status: 'ok'; checks: { database: 'ok'; sqs: 'ok' } }> {
    const checks = await Promise.all([
      this.checkDatabase(),
      this.checkSqs(),
    ]);
    if (!checks[0] || !checks[1]) {
      throw new ServiceUnavailableException({
        status: 'error',
        checks: {
          database: checks[0] ? 'ok' : 'error',
          sqs: checks[1] ? 'ok' : 'error',
        },
      });
    }
    return { status: 'ok', checks: { database: 'ok', sqs: 'ok' } };
  }

  onModuleDestroy(): void {
    this.sqsClient.destroy();
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.em.getConnection().execute('select 1');
      return true;
    } catch {
      return false;
    }
  }

  private async checkSqs(): Promise<boolean> {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) return false;

    try {
      await this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}
