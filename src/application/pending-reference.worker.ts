import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InsufficientWalletFundsError } from '../domain/wallet/wallet.js';
import {
  InvalidWagerTransactionStateError,
  WagerTransactionKind,
} from '../domain/wager-transaction/wager-transaction.js';
import {
  InvalidReferencedTransactionError,
  WalletMovementService,
  WagerTransactionPendingReferenceError,
} from './wallet-movement.service.js';
import { WALLET_UNIT_OF_WORK, type WalletUnitOfWork } from './ports/wallet-unit-of-work.js';

const POLL_INTERVAL_MS = 1_000;
const PENDING_REFERENCE_BATCH_SIZE = 50;

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private interval?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @Inject(WALLET_UNIT_OF_WORK) private readonly unitOfWork: WalletUnitOfWork,
    private readonly movements: WalletMovementService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    this.interval = setInterval(() => void this.runSafely(), POLL_INTERVAL_MS);
    this.interval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  async runOnce(at = new Date()): Promise<number> {
    const pending = await this.unitOfWork.execute(({ transactions }) =>
      transactions.findDuePendingReferences(at, PENDING_REFERENCE_BATCH_SIZE),
    );
    let attempted = 0;

    for (const transaction of pending) {
      try {
        if (transaction.kind === WagerTransactionKind.Rollback) {
          await this.movements.rollback(transaction.id, at, true);
        } else {
          await this.movements.credit(transaction.id, at, true);
        }
        attempted += 1;
      } catch (error) {
        if (
          error instanceof WagerTransactionPendingReferenceError ||
          error instanceof InvalidReferencedTransactionError ||
          error instanceof InsufficientWalletFundsError ||
          error instanceof InvalidWagerTransactionStateError
        ) {
          attempted += 1;
          continue;
        }
        throw error;
      }
    }

    return attempted;
  }

  private async runSafely(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('Failed to process pending wager references', error);
    } finally {
      this.running = false;
    }
  }
}
