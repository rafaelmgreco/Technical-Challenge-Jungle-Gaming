import { Migration } from '@mikro-orm/migrations';

export class Migration20261116060000 extends Migration {
  override up(): void {
    this.addSql(`
      alter table "wager_transactions"
      add column "reference_attempt_count" integer not null default 0,
      add column "reference_next_attempt_at" timestamptz;
    `);
    this.addSql(`
      update "wager_transactions"
      set "reference_attempt_count" = 1,
          "reference_next_attempt_at" = now()
      where "status" = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_reference_attempt_count_check"
        check ("reference_attempt_count" >= 0),
      add constraint "wager_transactions_pending_reference_schedule_check"
        check ("status" <> 'PENDING_REFERENCE' or "reference_next_attempt_at" is not null);
    `);
  }

  override down(): void {
    this.addSql(`
      alter table "wager_transactions"
      drop constraint if exists "wager_transactions_pending_reference_schedule_check",
      drop constraint if exists "wager_transactions_reference_attempt_count_check",
      drop column if exists "reference_next_attempt_at",
      drop column if exists "reference_attempt_count";
    `);
  }
}
