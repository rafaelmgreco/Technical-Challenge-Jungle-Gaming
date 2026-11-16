export interface IntegrationEventRecord {
  id: string;
  aggregateId: string;
  eventType: 'WagerTransactionPendingReference' | 'WagerTransactionRejected';
  version: 1;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: Readonly<Record<string, unknown>>;
}

export interface IntegrationEventOutboxRepository {
  save(event: IntegrationEventRecord): Promise<void>;
}
