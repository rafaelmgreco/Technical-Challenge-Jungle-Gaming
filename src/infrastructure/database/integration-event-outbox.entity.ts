import { defineEntity, p } from '@mikro-orm/postgresql';

export const IntegrationEventOutboxEntitySchema = defineEntity({
  name: 'IntegrationEventOutboxEntity',
  tableName: 'integration_event_outbox',
  properties: {
    id: p.string().primary().columnType('text'),
    aggregateId: p.string().fieldName('aggregate_id').columnType('text'),
    eventType: p.string().fieldName('event_type').columnType('text'),
    version: p.integer().columnType('integer'),
    correlationId: p.string().fieldName('correlation_id').columnType('text'),
    causationId: p.string().fieldName('causation_id').nullable().columnType('text'),
    occurredAt: p.datetime().fieldName('occurred_at').columnType('timestamptz'),
    data: p.json().columnType('jsonb'),
    attempts: p.integer().columnType('integer'),
    nextAttemptAt: p.datetime().fieldName('next_attempt_at').columnType('timestamptz'),
    publishedAt: p.datetime().fieldName('published_at').nullable().columnType('timestamptz'),
  },
});

export class IntegrationEventOutboxEntity extends IntegrationEventOutboxEntitySchema.class {}
IntegrationEventOutboxEntitySchema.setClass(IntegrationEventOutboxEntity);
