import { defineEntity, p } from '@mikro-orm/postgresql';

export const InboxMessageEntitySchema = defineEntity({
  name: 'InboxMessageEntity',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p
      .string()
      .primary()
      .fieldName('consumer_name')
      .columnType('text'),
    messageId: p.string().primary().fieldName('message_id').columnType('text'),
    payloadHash: p.string().fieldName('payload_hash').columnType('text'),
    receivedAt: p.datetime().fieldName('received_at').columnType('timestamptz'),
    processedAt: p
      .datetime()
      .fieldName('processed_at')
      .columnType('timestamptz'),
  },
});

export class InboxMessageEntity extends InboxMessageEntitySchema.class {}
InboxMessageEntitySchema.setClass(InboxMessageEntity);
