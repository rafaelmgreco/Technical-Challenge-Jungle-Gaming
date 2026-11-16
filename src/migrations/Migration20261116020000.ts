import { Migration } from '@mikro-orm/migrations';

export class Migration20261116020000 extends Migration {
  override up(): void {
    this.addSql(`
      create table "wager_transactions" (
        "id" text primary key,
        "provider_id" text not null,
        "external_transaction_id" text not null,
        "idempotency_key" text not null,
        "payload_hash" text not null,
        "wallet_id" text not null,
        "player_id" text not null,
        "round_id" text not null,
        "game_id" text not null,
        "kind" text not null,
        "amount_minor_units" bigint not null,
        "currency" char(3) not null,
        "reference_external_transaction_id" text,
        "created_at" timestamptz not null,
        "status" text not null,
        "reference_transaction_id" text,
        "failure_code" text,
        "processed_at" timestamptz,
        constraint "wager_transactions_provider_idempotency_unique" unique ("provider_id", "idempotency_key"),
        constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_id_wallet_currency_unique" unique ("id", "wallet_id", "currency"),
        constraint "wager_transactions_wallet_currency_fk" foreign key ("wallet_id", "currency")
          references "wallets" ("id", "currency") on delete restrict,
        constraint "wager_transactions_reference_fk" foreign key ("reference_transaction_id")
          references "wager_transactions" ("id") on delete restrict,
        constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_currency_format_check" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_amount_positive_check" check ("amount_minor_units" > 0),
        constraint "wager_transactions_pending_reference_check" check (
          "status" <> 'PENDING_REFERENCE' or "reference_external_transaction_id" is not null
        ),
        constraint "wager_transactions_failure_code_check" check (
          ("status" in ('REJECTED', 'FAILED') and "failure_code" ~ '^[A-Z][A-Z0-9_]*$')
          or
          ("status" not in ('REJECTED', 'FAILED') and "failure_code" is null)
        ),
        constraint "wager_transactions_processed_at_check" check (
          ("status" = 'PROCESSED' and "processed_at" is not null)
          or
          ("status" <> 'PROCESSED' and "processed_at" is null)
        ),
        constraint "wager_transactions_processed_reference_check" check (
          "status" <> 'PROCESSED'
          or "reference_external_transaction_id" is null
          or "reference_transaction_id" is not null
        )
      );
    `);
    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_transaction_wallet_currency_fk"
      foreign key ("transaction_id", "wallet_id", "currency")
      references "wager_transactions" ("id", "wallet_id", "currency") on delete restrict;
    `);
  }

  override down(): void {
    this.addSql(`
      alter table "wallet_ledger_entries"
      drop constraint if exists "wallet_ledger_transaction_wallet_currency_fk";
    `);
    this.addSql('drop table if exists "wager_transactions";');
  }
}
