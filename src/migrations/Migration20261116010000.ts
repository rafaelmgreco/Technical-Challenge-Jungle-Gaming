import { Migration } from '@mikro-orm/migrations';

export class Migration20261116010000 extends Migration {
  override up(): void {
    this.addSql(`alter table "wallets" add constraint "wallets_id_currency_unique" unique ("id", "currency");`);
    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" text primary key,
        "wallet_id" text not null,
        "transaction_id" text not null,
        "direction" text not null,
        "currency" char(3) not null,
        "amount_minor_units" bigint not null,
        "balance_before_minor_units" bigint not null,
        "balance_after_minor_units" bigint not null,
        "created_at" timestamptz not null,
        constraint "wallet_ledger_wallet_transaction_unique" unique ("wallet_id", "transaction_id"),
        constraint "wallet_ledger_wallet_currency_fk" foreign key ("wallet_id", "currency")
          references "wallets" ("id", "currency") on delete restrict,
        constraint "wallet_ledger_direction_check" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_currency_format_check" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_ledger_amount_positive_check" check ("amount_minor_units" > 0),
        constraint "wallet_ledger_balances_non_negative_check" check (
          "balance_before_minor_units" >= 0 and "balance_after_minor_units" >= 0
        ),
        constraint "wallet_ledger_balanced_movement_check" check (
          ("direction" = 'DEBIT' and "balance_before_minor_units" - "balance_after_minor_units" = "amount_minor_units")
          or
          ("direction" = 'CREDIT' and "balance_after_minor_units" - "balance_before_minor_units" = "amount_minor_units")
        )
      );
    `);
  }

  override down(): void {
    this.addSql('drop table if exists "wallet_ledger_entries";');
    this.addSql('alter table "wallets" drop constraint if exists "wallets_id_currency_unique";');
  }
}
