import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletEntity } from './wallet.entity.js';
import { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from './wager-transaction.entity.js';
import { IntegrationEventOutboxEntity } from './integration-event-outbox.entity.js';
import { InboxMessageEntity } from './inbox-message.entity.js';

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ??
    'postgresql://jungle:jungle_dev_password@localhost:5432/jungle',
  entities: [
    WalletEntity,
    WalletLedgerEntryEntity,
    WagerTransactionEntity,
    IntegrationEventOutboxEntity,
    InboxMessageEntity,
  ],
  metadataProvider: ReflectMetadataProvider,
  discovery: {
    warnWhenNoEntities: false,
  },
  extensions: [Migrator],
  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    emit: 'ts',
  },
});
