import { Migration } from '@mikro-orm/migrations';

export class Migration20261116030000 extends Migration {
  override up(): void {
    this.addSql(`
      alter table "wager_transactions"
      add column "processed_balance_minor_units" bigint,
      add constraint "wager_transactions_processed_balance_non_negative_check"
        check ("processed_balance_minor_units" is null or "processed_balance_minor_units" >= 0);
    `);
  }

  override down(): void {
    this.addSql(`
      alter table "wager_transactions"
      drop constraint if exists "wager_transactions_processed_balance_non_negative_check",
      drop column if exists "processed_balance_minor_units";
    `);
  }
}
