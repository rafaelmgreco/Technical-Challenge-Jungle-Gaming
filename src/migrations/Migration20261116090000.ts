import { Migration } from '@mikro-orm/migrations';

export class Migration20261116090000 extends Migration {
  override up(): void {
    this.addSql(
      'alter table "integration_event_outbox" add column "lease_owner" text null;',
    );
    this.addSql(
      'alter table "integration_event_outbox" add column "lease_until" timestamptz null;',
    );
    this.addSql(`
      create index "integration_event_outbox_lease_idx"
      on "integration_event_outbox" ("lease_until")
      where "published_at" is null;
    `);
  }

  override down(): void {
    this.addSql('drop index if exists "integration_event_outbox_lease_idx";');
    this.addSql(
      'alter table "integration_event_outbox" drop column if exists "lease_until";',
    );
    this.addSql(
      'alter table "integration_event_outbox" drop column if exists "lease_owner";',
    );
  }
}
