import { defineEntity, p } from '@mikro-orm/postgresql';

export const WalletLedgerEntryEntitySchema = defineEntity({
  name: 'WalletLedgerEntryEntity',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.string().primary().columnType('text'),
    walletId: p.string().fieldName('wallet_id').columnType('text'),
    transactionId: p.string().fieldName('transaction_id').columnType('text'),
    direction: p.string().columnType('text'),
    currency: p.string().columnType('char(3)'),
    amountMinorUnits: p.bigint().fieldName('amount_minor_units').columnType('bigint'),
    balanceBeforeMinorUnits: p.bigint().fieldName('balance_before_minor_units').columnType('bigint'),
    balanceAfterMinorUnits: p.bigint().fieldName('balance_after_minor_units').columnType('bigint'),
    createdAt: p.datetime().fieldName('created_at').columnType('timestamptz'),
  },
});

export class WalletLedgerEntryEntity extends WalletLedgerEntryEntitySchema.class {}
WalletLedgerEntryEntitySchema.setClass(WalletLedgerEntryEntity);
