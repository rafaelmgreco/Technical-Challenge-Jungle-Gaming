export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date;
}

export interface InboxMessageRepository {
  recordProcessed(message: InboxMessageRecord): Promise<boolean>;
  find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessageRecord | null>;
}

export class InboxMessageConflictError extends Error {
  constructor(consumerName: string, messageId: string) {
    super(
      `Message ${messageId} for consumer ${consumerName} was received with a different payload`,
    );
    this.name = 'InboxMessageConflictError';
  }
}
