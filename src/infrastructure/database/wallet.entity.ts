import { defineEntity, p } from '@mikro-orm/postgresql';

export const WalletEntitySchema = defineEntity({
  name: 'WalletEntity',
  tableName: 'wallets',
  properties: {
    id: p.string().primary().columnType('text'),
    playerId: p.string().fieldName('player_id').columnType('text'),
    currency: p.string().columnType('char(3)'),
    balanceMinorUnits: p.bigint().fieldName('balance_minor_units').columnType('bigint'),
    version: p.integer().default(1),
    createdAt: p.datetime().fieldName('created_at').columnType('timestamptz'),
    updatedAt: p.datetime().fieldName('updated_at').columnType('timestamptz'),
  },
});

export class WalletEntity extends WalletEntitySchema.class {}
WalletEntitySchema.setClass(WalletEntity);
