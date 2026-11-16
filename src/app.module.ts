import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './infrastructure/database/mikro-orm.config.js';
import { WALLET_UNIT_OF_WORK } from './application/ports/wallet-unit-of-work.js';
import { WalletMovementService } from './application/wallet-movement.service.js';
import { RegisterWagerTransactionService } from './application/register-wager-transaction.service.js';
import { MikroOrmWalletUnitOfWork } from './infrastructure/persistence/mikro-orm-wallet-unit-of-work.js';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...mikroOrmConfig,
      autoLoadEntities: true,
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    WalletMovementService,
    RegisterWagerTransactionService,
    MikroOrmWalletUnitOfWork,
    { provide: WALLET_UNIT_OF_WORK, useExisting: MikroOrmWalletUnitOfWork },
  ],
})
export class AppModule {}
