import { Migration } from '@mikro-orm/migrations';

export class Migration20261116080000 extends Migration {
  override up(): void {
    this.addSql(`
      create table "integration_event_outbox" (
        "id" text primary key,
        "aggregate_id" text not null,
        "event_type" text not null,
        "version" integer not null,
        "correlation_id" text not null,
        "causation_id" text,
        "occurred_at" timestamptz not null,
        "data" jsonb not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz not null,
        "published_at" timestamptz,
        constraint "integration_event_outbox_aggregate_fk" foreign key ("aggregate_id")
          references "wager_transactions" ("id") on delete restrict,
        constraint "integration_event_outbox_version_check" check ("version" > 0),
        constraint "integration_event_outbox_attempts_check" check ("attempts" >= 0)
      );
    `);
    this.addSql(`
      create index "integration_event_outbox_unpublished_due_idx"
      on "integration_event_outbox" ("next_attempt_at", "occurred_at")
      where "published_at" is null;
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists "integration_event_outbox_unpublished_due_idx";`);
    this.addSql('drop table if exists "integration_event_outbox";');
  }
}
