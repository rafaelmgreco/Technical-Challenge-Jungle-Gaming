export interface IntegrationEventRecord {
  id: string;
  aggregateId: string;
  eventType:
    | 'WagerTransactionPendingReference'
    | 'WagerTransactionRejected'
    | 'WagerTransactionProcessed'
    | 'WalletBalanceChanged';
  version: 1;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: Readonly<Record<string, unknown>>;
  attempts?: number;
}

export interface IntegrationEventOutboxRepository {
  save(event: IntegrationEventRecord): Promise<void>;
  claimDue(input: {
    workerId: string;
    at: Date;
    leaseUntil: Date;
    limit: number;
  }): Promise<IntegrationEventRecord[]>;
  markPublished(input: {
    eventId: string;
    workerId: string;
    at: Date;
  }): Promise<boolean>;
  scheduleRetry(input: {
    eventId: string;
    workerId: string;
    nextAttemptAt: Date;
  }): Promise<boolean>;
}
