import { EntityManager } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import type {
  InboxMessageRecord,
  InboxMessageRepository,
} from '../../application/ports/inbox-message.repository.js';
import { InboxMessageConflictError } from '../../application/ports/inbox-message.repository.js';
import { InboxMessageEntity } from '../database/inbox-message.entity.js';

@Injectable()
export class MikroOrmInboxMessageRepository implements InboxMessageRepository {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async recordProcessed(message: InboxMessageRecord): Promise<boolean> {
    const result = await this.em.getConnection().execute(
      `insert into "inbox_messages" ("consumer_name", "message_id", "payload_hash", "received_at", "processed_at")
       values (?, ?, ?, ?, ?)
       on conflict ("consumer_name", "message_id") do nothing
       returning "message_id"`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt,
      ],
      'all',
      this.em.getTransactionContext(),
    );
    const existing = await this.find(message.consumerName, message.messageId);
    if (!existing || existing.payloadHash !== message.payloadHash) {
      throw new InboxMessageConflictError(
        message.consumerName,
        message.messageId,
      );
    }
    return result.length > 0;
  }

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessageRecord | null> {
    const entity = await this.em.findOne(InboxMessageEntity, {
      consumerName,
      messageId,
    });
    if (!entity) return null;
    return {
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt,
      processedAt: entity.processedAt,
    };
  }
}
