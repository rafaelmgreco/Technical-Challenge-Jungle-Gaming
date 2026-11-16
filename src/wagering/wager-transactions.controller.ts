import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Res,
  UnprocessableEntityException,
  Body,
} from '@nestjs/common';
import type { Response } from 'express';
import { Money } from '../domain/money/money.js';
import { InsufficientWalletFundsError } from '../domain/wallet/wallet.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction/wager-transaction.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  RegisterWagerTransactionService,
} from '../application/register-wager-transaction.service.js';
import {
  InvalidReferencedTransactionError,
  WalletMovementService,
  WalletNotFoundError,
} from '../application/wallet-movement.service.js';
import { WALLET_UNIT_OF_WORK, type WalletUnitOfWork } from '../application/ports/wallet-unit-of-work.js';

interface SubmitWagerTransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

function badRequest(message: string): BadRequestException {
  return new BadRequestException({ code: 'INVALID_REQUEST', message });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`${field} must be a non-empty string`);
  }
  return value;
}

function parseBody(value: unknown): SubmitWagerTransactionBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Request body must be a JSON object');
  }
  const body = value as Record<string, unknown>;
  const kindValue = requiredString(body.kind, 'kind');
  if (!Object.values(WagerTransactionKind).includes(kindValue as WagerTransactionKind)) {
    throw badRequest('kind is not a supported wager transaction kind');
  }
  const kind = kindValue as WagerTransactionKind;
  if (
    kind !== WagerTransactionKind.Bet &&
    kind !== WagerTransactionKind.Win &&
    kind !== WagerTransactionKind.Loss &&
    kind !== WagerTransactionKind.Refund &&
    kind !== WagerTransactionKind.Rollback
  ) {
    throw new UnprocessableEntityException({
      code: 'UNSUPPORTED_TRANSACTION_KIND',
      message: `The HTTP endpoint currently processes BET, WIN, LOSS, REFUND, and ROLLBACK; ${kind} is not available yet`,
    });
  }
  const referenceExternalTransactionId = body.referenceExternalTransactionId === undefined
    ? undefined
    : requiredString(body.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if (
    referenceExternalTransactionId !== undefined &&
    kind !== WagerTransactionKind.Win &&
    kind !== WagerTransactionKind.Refund &&
    kind !== WagerTransactionKind.Rollback
  ) {
    throw new UnprocessableEntityException({
      code: 'UNSUPPORTED_REFERENCE_KIND',
      message: 'The HTTP endpoint currently supports references only for WIN, REFUND, and ROLLBACK transactions',
    });
  }
  if (
    (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) &&
    referenceExternalTransactionId === undefined
  ) {
    throw badRequest(`referenceExternalTransactionId is required for ${kind}`);
  }
  if (body.money === null || typeof body.money !== 'object' || Array.isArray(body.money)) {
    throw badRequest('money must contain amount and currency');
  }
  const moneyProps = body.money as Record<string, unknown>;
  let money: Money;
  try {
    money = Money.from({
      amount: requiredString(moneyProps.amount, 'money.amount'),
      currency: requiredString(moneyProps.currency, 'money.currency'),
    });
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'money is invalid');
  }

  return {
    providerId: requiredString(body.providerId, 'providerId'),
    externalTransactionId: requiredString(body.externalTransactionId, 'externalTransactionId'),
    playerId: requiredString(body.playerId, 'playerId'),
    walletId: requiredString(body.walletId, 'walletId'),
    roundId: requiredString(body.roundId, 'roundId'),
    gameId: requiredString(body.gameId, 'gameId'),
    kind,
    money,
    referenceExternalTransactionId,
  };
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const fields = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

@Controller('wagering/transactions')
export class WagerTransactionsController {
  constructor(
    private readonly registration: RegisterWagerTransactionService,
    private readonly movements: WalletMovementService,
    @Inject(WALLET_UNIT_OF_WORK) private readonly unitOfWork: WalletUnitOfWork,
  ) {}

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    if (!idempotencyHeader || idempotencyHeader.trim().length === 0) {
      throw badRequest('Idempotency-Key header is required');
    }
    const body = parseBody(rawBody);
    const payload = {
      externalTransactionId: body.externalTransactionId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money.toJSON(),
      playerId: body.playerId,
      providerId: body.providerId,
      roundId: body.roundId,
      ...(body.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: body.referenceExternalTransactionId }),
      walletId: body.walletId,
    };
    const payloadHash = createHash('sha256').update(canonicalize(payload)).digest('hex');

    let registrationResult;
    try {
      registrationResult = await this.registration.register({
        id: crypto.randomUUID(),
        ...body,
        idempotencyKey: idempotencyHeader.trim(),
        payloadHash,
        createdAt: new Date(),
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError || error instanceof ExternalTransactionConflictError) {
        throw new ConflictException({ code: 'TRANSACTION_CONFLICT', message: error.message });
      }
      throw error;
    }

    const transaction = registrationResult.transaction;
    if (transaction.status === WagerTransactionStatus.Pending) {
      try {
        if (transaction.kind === WagerTransactionKind.Loss) {
          await this.movements.processLoss(transaction.id);
        } else if (transaction.kind === WagerTransactionKind.Bet) {
          await this.movements.debit(transaction.id);
        } else if (transaction.kind === WagerTransactionKind.Rollback) {
          await this.movements.rollback(transaction.id);
        } else {
          await this.movements.credit(transaction.id);
        }
      } catch (error) {
        if (error instanceof InsufficientWalletFundsError) {
          response.status(HttpStatus.UNPROCESSABLE_ENTITY);
          return {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Rejected,
            failureCode: error.failureCode,
            idempotentReplay: registrationResult.replayed,
          };
        }
        if (error instanceof InvalidReferencedTransactionError) {
          response.status(HttpStatus.UNPROCESSABLE_ENTITY);
          return {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Rejected,
            failureCode: error.failureCode,
            idempotentReplay: registrationResult.replayed,
          };
        }
        if (error instanceof WalletNotFoundError) {
          throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: error.message });
        }
        throw error;
      }
    }

    if (transaction.status === WagerTransactionStatus.Rejected) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY);
      return {
        transactionId: transaction.id,
        status: transaction.status,
        failureCode: transaction.failureCode,
        idempotentReplay: registrationResult.replayed,
      };
    }

    const processed = await this.unitOfWork.execute(async ({ transactions, ledger }) => ({
      transaction: await transactions.findById(transaction.id),
      entry: await ledger.findByWalletAndTransactionId(transaction.walletId, transaction.id),
    }));
    const resultBalance = processed.transaction?.processedBalance ?? processed.entry?.balanceAfter;
    if (processed.transaction?.status !== WagerTransactionStatus.Processed || !resultBalance) {
      throw new InternalServerErrorException({
        code: 'PROCESSED_RESULT_MISSING',
        message: 'The processed transaction result could not be loaded',
      });
    }

    response.status(registrationResult.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return {
      transactionId: processed.transaction.id,
      status: processed.transaction.status,
      balance: resultBalance.toJSON(),
      idempotentReplay: registrationResult.replayed,
    };
  }
}
