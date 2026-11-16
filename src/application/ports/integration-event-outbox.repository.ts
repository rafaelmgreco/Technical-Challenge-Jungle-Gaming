export interface IntegrationEventMoney {
  amount: string;
  currency: string;
}

export interface IntegrationEventDataByType {
  WagerTransactionPendingReference: {
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    referenceExternalTransactionId: string;
    walletId: string;
    kind: string;
  };
  WagerTransactionRejected: {
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    kind: string;
    failureCode: string;
  };
  WagerTransactionProcessed: {
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    kind: string;
    money: IntegrationEventMoney;
    referenceTransactionId?: string;
    balance: IntegrationEventMoney;
  };
  WalletBalanceChanged: {
    walletId: string;
    transactionId: string;
    direction: 'DEBIT' | 'CREDIT';
    money: IntegrationEventMoney;
    balanceBefore: IntegrationEventMoney;
    balanceAfter: IntegrationEventMoney;
    walletVersion: number;
  };
}

export type IntegrationEventType = keyof IntegrationEventDataByType;

interface IntegrationEventRecordBase<T extends IntegrationEventType> {
  id: string;
  aggregateId: string;
  eventType: T;
  version: 1;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: Readonly<IntegrationEventDataByType[T]>;
  attempts?: number;
}

export type IntegrationEventRecord = {
  [T in IntegrationEventType]: IntegrationEventRecordBase<T>;
}[IntegrationEventType];

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
