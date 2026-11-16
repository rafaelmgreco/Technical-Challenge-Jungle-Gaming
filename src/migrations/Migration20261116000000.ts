import { Migration } from '@mikro-orm/migrations';

export class Migration20261116000000 extends Migration {
  override up(): void {
    this.addSql(`
      create table "wallets" (
        "id" text primary key,
        "player_id" text not null,
        "currency" char(3) not null,
        "balance_minor_units" bigint not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "wallets_player_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_currency_format_check" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_balance_non_negative_check" check ("balance_minor_units" >= 0),
        constraint "wallets_version_positive_check" check ("version" >= 1)
      );
    `);
  }

  override down(): void {
    this.addSql('drop table if exists "wallets";');
  }
}
