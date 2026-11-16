import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import type { IntegrationEventOutboxRepository } from './ports/integration-event-outbox.repository.js';
import { MikroOrmIntegrationEventOutboxRepository } from '../infrastructure/persistence/mikro-orm-integration-event-outbox.repository.js';
import {
  INTEGRATION_EVENT_PUBLISHER,
  type IntegrationEventPublisher,
} from './ports/integration-event-publisher.js';
import { StructuredLogger } from '../infrastructure/logging/structured-logger.js';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 10;
const LEASE_DURATION_MS = 30_000;
const MAX_RETRY_DELAY_MS = 300_000;

@Injectable()
export class IntegrationEventOutboxWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new StructuredLogger();
  private readonly workerId = crypto.randomUUID();
  private interval?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(INTEGRATION_EVENT_PUBLISHER)
    private readonly publisher: IntegrationEventPublisher,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !process.env.SQS_QUEUE_URL) {
      return;
    }
    this.interval = setInterval(() => void this.runSafely(), POLL_INTERVAL_MS);
    this.interval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  async runOnce(at = new Date()): Promise<number> {
    const outbox: IntegrationEventOutboxRepository =
      new MikroOrmIntegrationEventOutboxRepository(this.em);
    const events = await outbox.claimDue({
      workerId: this.workerId,
      at,
      leaseUntil: new Date(at.getTime() + LEASE_DURATION_MS),
      limit: BATCH_SIZE,
    });
    let published = 0;

    for (const event of events) {
      try {
        await this.publisher.publish(event);
        this.logger.info('integration_event_published', {
          eventId: event.id,
          transactionId: event.aggregateId,
          correlationId: event.correlationId,
          ...(typeof event.data.walletId === 'string'
            ? { walletId: event.data.walletId }
            : {}),
          ...('providerId' in event.data
            ? { providerId: event.data.providerId }
            : {}),
        });
        if (
          await outbox.markPublished({
            eventId: event.id,
            workerId: this.workerId,
            at: new Date(),
          })
        )
          published += 1;
      } catch (error) {
        const attempts = Number(
          (event as typeof event & { attempts?: number }).attempts ?? 0,
        );
        const delay = Math.min(1_000 * 2 ** attempts, MAX_RETRY_DELAY_MS);
        await outbox.scheduleRetry({
          eventId: event.id,
          workerId: this.workerId,
          nextAttemptAt: new Date(Date.now() + delay),
        });
        this.logger.error(
          'integration_event_publish_failed',
          {
            eventId: event.id,
            transactionId: event.aggregateId,
            correlationId: event.correlationId,
            ...(typeof event.data.walletId === 'string'
              ? { walletId: event.data.walletId }
              : {}),
            ...('providerId' in event.data
              ? { providerId: event.data.providerId }
              : {}),
          },
          error,
        );
      }
    }
    return published;
  }

  private async runSafely(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('integration_event_outbox_poll_failed', {}, error);
    } finally {
      this.running = false;
    }
  }
}
