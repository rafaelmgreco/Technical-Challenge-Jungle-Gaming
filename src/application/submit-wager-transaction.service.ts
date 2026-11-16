import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Money } from '../domain/money/money.js';
import { InsufficientWalletFundsError } from '../domain/wallet/wallet.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction/wager-transaction.js';
import { RegisterWagerTransactionService } from './register-wager-transaction.service.js';
import {
  InvalidReferencedTransactionError,
  WalletMovementService,
  WalletNotFoundError,
  WagerTransactionPendingReferenceError,
} from './wallet-movement.service.js';
import {
  WALLET_UNIT_OF_WORK,
  type WalletUnitOfWork,
} from './ports/wallet-unit-of-work.js';
import {
  InboxMessageConflictError,
  type InboxMessageRecord,
} from './ports/inbox-message.repository.js';

export interface SubmitWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  idempotentReplay: boolean;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  balance?: ReturnType<Money['toJSON']>;
  duplicateMessage?: boolean;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

@Injectable()
export class SubmitWagerTransactionService {
  constructor(
    private readonly registration: RegisterWagerTransactionService,
    private readonly movements: WalletMovementService,
    @Inject(WALLET_UNIT_OF_WORK) private readonly unitOfWork: WalletUnitOfWork,
  ) {}

  async submit(
    input: SubmitWagerTransactionInput,
    inbox?: Omit<InboxMessageRecord, 'processedAt'>,
  ): Promise<SubmitWagerTransactionResult> {
    const payload = {
      externalTransactionId: input.externalTransactionId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money.toJSON(),
      playerId: input.playerId,
      providerId: input.providerId,
      roundId: input.roundId,
      ...(input.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
          }),
      walletId: input.walletId,
    };
    const payloadHash = createHash('sha256')
      .update(canonicalize(payload))
      .digest('hex');

    if (inbox) {
      const existingMessage = await this.unitOfWork.execute(
        ({ inbox: repository }) =>
          repository.find(inbox.consumerName, inbox.messageId),
      );
      if (existingMessage) {
        if (existingMessage.payloadHash !== inbox.payloadHash) {
          throw new InboxMessageConflictError(
            inbox.consumerName,
            inbox.messageId,
          );
        }
        return {
          transactionId: '',
          status: WagerTransactionStatus.Processed,
          idempotentReplay: true,
          duplicateMessage: true,
        };
      }
    }

    const registration = await this.registration.register({
      id: crypto.randomUUID(),
      ...input,
      payloadHash,
      createdAt: new Date(),
    });
    const transaction = registration.transaction;

    if (
      transaction.status === WagerTransactionStatus.Pending ||
      transaction.status === WagerTransactionStatus.PendingReference
    ) {
      try {
        if (transaction.kind === WagerTransactionKind.Loss) {
          await this.movements.processLoss(transaction.id, undefined, inbox);
        } else if (transaction.kind === WagerTransactionKind.Bet) {
          await this.movements.debit(transaction.id, undefined, inbox);
        } else if (transaction.kind === WagerTransactionKind.Rollback) {
          await this.movements.rollback(
            transaction.id,
            undefined,
            false,
            inbox,
          );
        } else {
          await this.movements.credit(transaction.id, undefined, false, inbox);
        }
      } catch (error) {
        if (
          error instanceof InsufficientWalletFundsError ||
          error instanceof InvalidReferencedTransactionError
        ) {
          return {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Rejected,
            failureCode: error.failureCode,
            idempotentReplay: registration.replayed,
          };
        }
        if (error instanceof WagerTransactionPendingReferenceError) {
          return {
            transactionId: transaction.id,
            status: WagerTransactionStatus.PendingReference,
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId,
            idempotentReplay: registration.replayed,
          };
        }
        if (error instanceof WalletNotFoundError) throw error;
        throw error;
      }
    }

    const persisted = await this.unitOfWork.execute(
      async ({ transactions, ledger, inbox: inboxRepository }) => {
        if (inbox) {
          await inboxRepository.recordProcessed({
            ...inbox,
            processedAt: new Date(),
          });
        }
        return {
          transaction: await transactions.findById(transaction.id),
          entry: await ledger.findByWalletAndTransactionId(
            transaction.walletId,
            transaction.id,
          ),
        };
      },
    );
    if (persisted.transaction?.status === WagerTransactionStatus.Rejected) {
      return {
        transactionId: persisted.transaction.id,
        status: persisted.transaction.status,
        failureCode: persisted.transaction.failureCode,
        idempotentReplay: registration.replayed,
      };
    }
    const balance =
      persisted.transaction?.processedBalance ?? persisted.entry?.balanceAfter;
    if (
      persisted.transaction?.status !== WagerTransactionStatus.Processed ||
      !balance
    ) {
      throw new Error(
        `Processed result missing for wager transaction ${transaction.id}`,
      );
    }
    return {
      transactionId: persisted.transaction.id,
      status: persisted.transaction.status,
      balance: balance.toJSON(),
      idempotentReplay: registration.replayed,
    };
  }
}
