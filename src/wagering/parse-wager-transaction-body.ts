import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Money } from '../domain/money/money.js';
import { WagerTransactionKind } from '../domain/wager-transaction/wager-transaction.js';

export interface SubmitWagerTransactionBody {
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

export function parseWagerTransactionBody(
  value: unknown,
): SubmitWagerTransactionBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Request body must be a JSON object');
  }
  const body = value as Record<string, unknown>;
  const kindValue = requiredString(body.kind, 'kind');
  if (
    !Object.values(WagerTransactionKind).includes(
      kindValue as WagerTransactionKind,
    )
  ) {
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
  const referenceExternalTransactionId =
    body.referenceExternalTransactionId === undefined
      ? undefined
      : requiredString(
          body.referenceExternalTransactionId,
          'referenceExternalTransactionId',
        );
  if (
    referenceExternalTransactionId !== undefined &&
    kind !== WagerTransactionKind.Win &&
    kind !== WagerTransactionKind.Refund &&
    kind !== WagerTransactionKind.Rollback
  ) {
    throw new UnprocessableEntityException({
      code: 'UNSUPPORTED_REFERENCE_KIND',
      message:
        'The HTTP endpoint currently supports references only for WIN, REFUND, and ROLLBACK transactions',
    });
  }
  if (
    (kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback) &&
    referenceExternalTransactionId === undefined
  ) {
    throw badRequest(`referenceExternalTransactionId is required for ${kind}`);
  }
  if (
    body.money === null ||
    typeof body.money !== 'object' ||
    Array.isArray(body.money)
  ) {
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
    throw badRequest(
      error instanceof Error ? error.message : 'money is invalid',
    );
  }

  return {
    providerId: requiredString(body.providerId, 'providerId'),
    externalTransactionId: requiredString(
      body.externalTransactionId,
      'externalTransactionId',
    ),
    playerId: requiredString(body.playerId, 'playerId'),
    walletId: requiredString(body.walletId, 'walletId'),
    roundId: requiredString(body.roundId, 'roundId'),
    gameId: requiredString(body.gameId, 'gameId'),
    kind,
    money,
    referenceExternalTransactionId,
  };
}
