import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './infrastructure/database/mikro-orm.config.js';
import { WALLET_UNIT_OF_WORK } from './application/ports/wallet-unit-of-work.js';
import { WalletMovementService } from './application/wallet-movement.service.js';
import { RegisterWagerTransactionService } from './application/register-wager-transaction.service.js';
import { WagerTransactionsController } from './wagering/wager-transactions.controller.js';
import { WalletsController } from './wallets/wallets.controller.js';
import { CreateWalletService } from './application/create-wallet.service.js';
import { MikroOrmWalletUnitOfWork } from './infrastructure/persistence/mikro-orm-wallet-unit-of-work.js';
import { PendingReferenceWorker } from './application/pending-reference.worker.js';
import { IntegrationEventOutboxWorker } from './application/integration-event-outbox.worker.js';
import { INTEGRATION_EVENT_PUBLISHER } from './application/ports/integration-event-publisher.js';
import { SqsIntegrationEventPublisher } from './infrastructure/messaging/sqs-integration-event-publisher.js';
import { SubmitWagerTransactionService } from './application/submit-wager-transaction.service.js';
import { SqsWagerTransactionConsumer } from './infrastructure/messaging/sqs-wager-transaction-consumer.js';
import { ReconcileWalletService } from './application/reconcile-wallet.service.js';
import { GetWalletService } from './application/get-wallet.service.js';
import { GetWalletLedgerPageService } from './application/get-wallet-ledger-page.service.js';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...mikroOrmConfig,
      autoLoadEntities: true,
    }),
  ],
  controllers: [AppController, WagerTransactionsController, WalletsController],
  providers: [
    AppService,
    WalletMovementService,
    RegisterWagerTransactionService,
    SubmitWagerTransactionService,
    PendingReferenceWorker,
    IntegrationEventOutboxWorker,
    SqsIntegrationEventPublisher,
    SqsWagerTransactionConsumer,
    {
      provide: INTEGRATION_EVENT_PUBLISHER,
      useExisting: SqsIntegrationEventPublisher,
    },
    CreateWalletService,
    ReconcileWalletService,
    GetWalletService,
    GetWalletLedgerPageService,
    MikroOrmWalletUnitOfWork,
    { provide: WALLET_UNIT_OF_WORK, useExisting: MikroOrmWalletUnitOfWork },
  ],
})
export class AppModule {}
