import { Inject, Injectable } from '@nestjs/common';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../domain/wager-transaction/wager-transaction.js';
import { WALLET_UNIT_OF_WORK, type WalletUnitOfWork } from './ports/wallet-unit-of-work.js';

export interface RegisterWagerTransactionResult {
  transaction: WagerTransaction;
  replayed: boolean;
}

export class IdempotencyConflictError extends Error {
  constructor(providerId: string, idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} for provider ${providerId} was reused with a different payload`);
    this.name = 'IdempotencyConflictError';
  }
}

export class ExternalTransactionConflictError extends Error {
  constructor(providerId: string, externalTransactionId: string) {
    super(`External transaction ${externalTransactionId} already exists for provider ${providerId}`);
    this.name = 'ExternalTransactionConflictError';
  }
}

@Injectable()
export class RegisterWagerTransactionService {
  constructor(@Inject(WALLET_UNIT_OF_WORK) private readonly unitOfWork: WalletUnitOfWork) {}

  async register(props: CreateWagerTransactionProps): Promise<RegisterWagerTransactionResult> {
    let outcome:
      | { kind: 'created'; transaction: WagerTransaction }
      | { kind: 'idempotency-match'; transaction: WagerTransaction }
      | { kind: 'external-conflict'; transaction: WagerTransaction };

    try {
      outcome = await this.unitOfWork.execute(async ({ transactions }) => {
        const existing = await transactions.findByProviderAndIdempotencyKey(
          props.providerId,
          props.idempotencyKey,
        );
        if (existing) {
          return { kind: 'idempotency-match', transaction: existing };
        }

        const externalTransaction = await transactions.findByProviderAndExternalTransactionId(
          props.providerId,
          props.externalTransactionId,
        );
        if (externalTransaction) {
          return { kind: 'external-conflict', transaction: externalTransaction };
        }

        const transaction = WagerTransaction.create(props);
        await transactions.save(transaction);
        return { kind: 'created', transaction };
      });
    } catch (error) {
      const raced = await this.findConcurrentRegistration(props);
      if (!raced) {
        throw error;
      }
      outcome = raced;
    }

    if (outcome.kind === 'created') {
      return { transaction: outcome.transaction, replayed: false };
    }
    if (outcome.kind === 'external-conflict') {
      throw new ExternalTransactionConflictError(props.providerId, props.externalTransactionId);
    }

    if (!outcome.transaction.matchesPayload(props.payloadHash)) {
      throw new IdempotencyConflictError(props.providerId, props.idempotencyKey);
    }

    return { transaction: outcome.transaction, replayed: true };
  }

  private async findConcurrentRegistration(
    props: CreateWagerTransactionProps,
  ): Promise<
    | { kind: 'idempotency-match'; transaction: WagerTransaction }
    | { kind: 'external-conflict'; transaction: WagerTransaction }
    | null
  > {
    try {
      return await this.unitOfWork.execute(async ({ transactions }) => {
        const byKey = await transactions.findByProviderAndIdempotencyKey(
          props.providerId,
          props.idempotencyKey,
        );
        if (byKey) {
          return { kind: 'idempotency-match', transaction: byKey };
        }

        const byExternalId = await transactions.findByProviderAndExternalTransactionId(
          props.providerId,
          props.externalTransactionId,
        );
        return byExternalId
          ? { kind: 'external-conflict', transaction: byExternalId }
          : null;
      });
    } catch {
      return null;
    }
  }
}
