import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Get,
  Param,
  Post,
  Res,
  Body,
} from '@nestjs/common';
import type { Response } from 'express';
import { WagerTransactionStatus } from '../domain/wager-transaction/wager-transaction.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from '../application/register-wager-transaction.service.js';
import { WalletNotFoundError } from '../application/wallet-movement.service.js';
import {
  SubmitWagerTransactionService,
  type SubmitWagerTransactionResult,
} from '../application/submit-wager-transaction.service.js';
import { parseWagerTransactionBody } from './parse-wager-transaction-body.js';
import {
  GetWagerTransactionService,
  WagerTransactionNotFoundError,
} from '../application/get-wager-transaction.service.js';
import { toWagerTransactionResponse } from './wager-transaction-response.js';

@Controller('wagering/transactions')
export class WagerTransactionsController {
  constructor(
    private readonly submissions: SubmitWagerTransactionService,
    private readonly getTransactions: GetWagerTransactionService,
  ) {}

  @Get(':transactionId')
  async getById(
    @Param('transactionId') transactionId: string,
  ): Promise<Record<string, unknown>> {
    try {
      return toWagerTransactionResponse(
        await this.getTransactions.byId(transactionId),
      );
    } catch (error) {
      if (error instanceof WagerTransactionNotFoundError) {
        throw new NotFoundException({
          code: 'WAGER_TRANSACTION_NOT_FOUND',
          message: error.message,
        });
      }
      throw error;
    }
  }

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    if (!idempotencyHeader || idempotencyHeader.trim().length === 0) {
      throw new BadRequestException({
        code: 'INVALID_REQUEST',
        message: 'Idempotency-Key header is required',
      });
    }

    let result: SubmitWagerTransactionResult;
    try {
      result = await this.submissions.submit({
        ...parseWagerTransactionBody(rawBody),
        idempotencyKey: idempotencyHeader.trim(),
      });
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof ExternalTransactionConflictError
      ) {
        throw new ConflictException({
          code: 'TRANSACTION_CONFLICT',
          message: error.message,
        });
      }
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException({
          code: 'WALLET_NOT_FOUND',
          message: error.message,
        });
      }
      if (
        error instanceof Error &&
        error.message.startsWith('Processed result missing')
      ) {
        throw new InternalServerErrorException({
          code: 'PROCESSED_RESULT_MISSING',
          message: error.message,
        });
      }
      throw error;
    }

    if (result.status === WagerTransactionStatus.PendingReference) {
      response.status(HttpStatus.ACCEPTED);
    } else if (result.status === WagerTransactionStatus.Rejected) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else {
      response.status(
        result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED,
      );
    }
    return {
      transactionId: result.transactionId,
      status: result.status,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      ...(result.referenceExternalTransactionId
        ? {
            referenceExternalTransactionId:
              result.referenceExternalTransactionId,
          }
        : {}),
      ...(result.balance ? { balance: result.balance } : {}),
      idempotentReplay: result.idempotentReplay,
    };
  }
}
