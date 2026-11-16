import type { IntegrationEventRecord } from './integration-event-outbox.repository.js';

export const INTEGRATION_EVENT_PUBLISHER = Symbol(
  'INTEGRATION_EVENT_PUBLISHER',
);

export interface IntegrationEventPublisher {
  publish(event: IntegrationEventRecord): Promise<void>;
}
