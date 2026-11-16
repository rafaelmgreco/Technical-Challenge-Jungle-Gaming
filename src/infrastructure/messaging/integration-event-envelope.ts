import type {
  IntegrationEventDataByType,
  IntegrationEventRecord,
  IntegrationEventType,
} from '../../application/ports/integration-event-outbox.repository.js';

export type IntegrationEventEnvelopeV1 = {
  [T in IntegrationEventType]: {
    id: string;
    aggregateId: string;
    eventType: T;
    version: 1;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    data: Readonly<IntegrationEventDataByType[T]>;
  };
}[IntegrationEventType];

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
  } as IntegrationEventEnvelopeV1;
}

export function serializeIntegrationEvent(
  event: IntegrationEventRecord,
): string {
  return JSON.stringify(toIntegrationEventEnvelope(event));
}
