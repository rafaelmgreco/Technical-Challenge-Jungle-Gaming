import { defineEntity, p } from '@mikro-orm/postgresql';

export const WagerTransactionEntitySchema = defineEntity({
  name: 'WagerTransactionEntity',
  tableName: 'wager_transactions',
  properties: {
    id: p.string().primary().columnType('text'),
    providerId: p.string().fieldName('provider_id').columnType('text'),
    externalTransactionId: p.string().fieldName('external_transaction_id').columnType('text'),
    idempotencyKey: p.string().fieldName('idempotency_key').columnType('text'),
    payloadHash: p.string().fieldName('payload_hash').columnType('text'),
    walletId: p.string().fieldName('wallet_id').columnType('text'),
    playerId: p.string().fieldName('player_id').columnType('text'),
    roundId: p.string().fieldName('round_id').columnType('text'),
    gameId: p.string().fieldName('game_id').columnType('text'),
    kind: p.string().columnType('text'),
    amountMinorUnits: p.bigint().fieldName('amount_minor_units').columnType('bigint'),
    currency: p.string().columnType('char(3)'),
    referenceExternalTransactionId: p.string().fieldName('reference_external_transaction_id').nullable().columnType('text'),
    createdAt: p.datetime().fieldName('created_at').columnType('timestamptz'),
    status: p.string().columnType('text'),
    referenceTransactionId: p.string().fieldName('reference_transaction_id').nullable().columnType('text'),
    failureCode: p.string().fieldName('failure_code').nullable().columnType('text'),
    processedAt: p.datetime().fieldName('processed_at').nullable().columnType('timestamptz'),
    processedBalanceMinorUnits: p.bigint().fieldName('processed_balance_minor_units').nullable().columnType('bigint'),
    referenceAttemptCount: p.integer().fieldName('reference_attempt_count').columnType('integer'),
    referenceNextAttemptAt: p.datetime().fieldName('reference_next_attempt_at').nullable().columnType('timestamptz'),
  },
});

export class WagerTransactionEntity extends WagerTransactionEntitySchema.class {}
WagerTransactionEntitySchema.setClass(WagerTransactionEntity);
