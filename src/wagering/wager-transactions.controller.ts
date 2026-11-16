import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  Inject,
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
import { StructuredLogger } from '../infrastructure/logging/structured-logger.js';
import { MetricsRegistry } from '../infrastructure/metrics/metrics.registry.js';

@Controller('wagering/transactions')
export class WagerTransactionsController {
  private readonly logger = new StructuredLogger();

  constructor(
    private readonly submissions: SubmitWagerTransactionService,
    private readonly getTransactions: GetWagerTransactionService,
    @Inject(MetricsRegistry)
    private readonly metrics: MetricsRegistry = new MetricsRegistry(),
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
    const startedAt = performance.now();
    if (!idempotencyHeader || idempotencyHeader.trim().length === 0) {
      throw new BadRequestException({
        code: 'INVALID_REQUEST',
        message: 'Idempotency-Key header is required',
      });
    }

    let result: SubmitWagerTransactionResult;
    try {
      const input = parseWagerTransactionBody(rawBody);
      result = await this.submissions.submit({
        ...input,
        idempotencyKey: idempotencyHeader.trim(),
      });
      this.logger.info('wager_transaction_http_submitted', {
        correlationId: idempotencyHeader.trim(),
        transactionId: result.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      });
      this.metrics.recordTransaction(result.status, 'http');
      if (result.idempotentReplay) this.metrics.recordDuplicate();
      this.metrics.observeProcessingDurationSeconds(
        (performance.now() - startedAt) / 1_000,
      );
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
