import { Migration } from '@mikro-orm/migrations';

export class Migration20261116070000 extends Migration {
  override up(): void {
    this.addSql(`
      create index "wager_transactions_pending_reference_due_idx"
      on "wager_transactions" ("reference_next_attempt_at", "created_at")
      where "status" = 'PENDING_REFERENCE';
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists "wager_transactions_pending_reference_due_idx";`);
  }
}
