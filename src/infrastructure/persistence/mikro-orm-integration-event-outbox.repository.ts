import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import type { IntegrationEventOutboxRepository, IntegrationEventRecord } from '../../application/ports/integration-event-outbox.repository.js';
import { IntegrationEventOutboxEntity } from '../database/integration-event-outbox.entity.js';

@Injectable()
export class MikroOrmIntegrationEventOutboxRepository implements IntegrationEventOutboxRepository {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async save(event: IntegrationEventRecord): Promise<void> {
    const entity = this.em.create(IntegrationEventOutboxEntity, {
      id: event.id,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      version: event.version,
      correlationId: event.correlationId,
      causationId: event.causationId ?? null,
      occurredAt: event.occurredAt,
      data: event.data,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: null,
    });
    this.em.persist(entity);
    await this.em.flush();
  }
}
