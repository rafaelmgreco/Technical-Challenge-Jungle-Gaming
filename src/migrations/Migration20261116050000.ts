import { Migration } from '@mikro-orm/migrations';

export class Migration20261116050000 extends Migration {
  override up(): void {
    this.addSql(`
      create unique index "wager_transactions_processed_rollback_reference_unique"
      on "wager_transactions" ("reference_transaction_id")
      where "kind" = 'ROLLBACK' and "status" = 'PROCESSED';
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists "wager_transactions_processed_rollback_reference_unique";`);
  }
}
