import type { IntegrationEventRecord } from '../../application/ports/integration-event-outbox.repository.js';

export interface IntegrationEventEnvelopeV1 {
  id: string;
  aggregateId: string;
  eventType: IntegrationEventRecord['eventType'];
  version: 1;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  data: Readonly<Record<string, unknown>>;
}

export function toIntegrationEventEnvelope(
  event: IntegrationEventRecord,
): IntegrationEventEnvelopeV1 {
  return {
    id: event.id,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    version: event.version,
    correlationId: event.correlationId,
    ...(event.causationId === undefined
      ? {}
      : { causationId: event.causationId }),
    occurredAt: event.occurredAt.toISOString(),
    data: event.data,
  };
}

export function serializeIntegrationEvent(
  event: IntegrationEventRecord,
): string {
  return JSON.stringify(toIntegrationEventEnvelope(event));
}
