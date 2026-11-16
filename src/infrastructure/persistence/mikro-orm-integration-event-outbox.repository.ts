import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import type {
  IntegrationEventOutboxRepository,
  IntegrationEventRecord,
} from '../../application/ports/integration-event-outbox.repository.js';
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

  async claimDue(input: {
    workerId: string;
    at: Date;
    leaseUntil: Date;
    limit: number;
  }): Promise<IntegrationEventRecord[]> {
    return this.em.transactional(async (em) => {
      const rows = await em
        .getConnection()
        .execute<Array<Record<string, unknown>>>(
          `with due as (
          select "id" from "integration_event_outbox"
          where "published_at" is null and "next_attempt_at" <= ?
            and ("lease_until" is null or "lease_until" <= ?)
          order by "next_attempt_at", "occurred_at", "id"
          for update skip locked
          limit ?
        )
        update "integration_event_outbox" as outbox
        set "lease_owner" = ?, "lease_until" = ?
        from due
        where outbox."id" = due."id"
        returning outbox."id", outbox."aggregate_id", outbox."event_type", outbox."version",
          outbox."correlation_id", outbox."causation_id", outbox."occurred_at", outbox."data", outbox."attempts"`,
          [input.at, input.at, input.limit, input.workerId, input.leaseUntil],
          'all',
          em.getTransactionContext(),
        );

      return rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        aggregateId: String(row.aggregate_id),
        eventType: row.event_type as IntegrationEventRecord['eventType'],
        version: Number(row.version) as 1,
        correlationId: String(row.correlation_id),
        ...(typeof row.causation_id === 'string'
          ? { causationId: row.causation_id }
          : {}),
        occurredAt: new Date(row.occurred_at as string | Date),
        data: row.data as Readonly<Record<string, unknown>>,
        attempts: Number(row.attempts),
      }));
    });
  }

  async markPublished(input: {
    eventId: string;
    workerId: string;
    at: Date;
  }): Promise<boolean> {
    const affected = await this.em.getConnection().execute(
      `update "integration_event_outbox"
       set "published_at" = ?, "lease_owner" = null, "lease_until" = null
       where "id" = ? and "lease_owner" = ? and "published_at" is null`,
      [input.at, input.eventId, input.workerId],
      'run',
      this.em.getTransactionContext(),
    );
    return affected.affectedRows > 0;
  }

  async scheduleRetry(input: {
    eventId: string;
    workerId: string;
    nextAttemptAt: Date;
  }): Promise<boolean> {
    const affected = await this.em.getConnection().execute(
      `update "integration_event_outbox"
       set "attempts" = "attempts" + 1, "next_attempt_at" = ?, "lease_owner" = null, "lease_until" = null
       where "id" = ? and "lease_owner" = ? and "published_at" is null`,
      [input.nextAttemptAt, input.eventId, input.workerId],
      'run',
      this.em.getTransactionContext(),
    );
    return affected.affectedRows > 0;
  }
}
