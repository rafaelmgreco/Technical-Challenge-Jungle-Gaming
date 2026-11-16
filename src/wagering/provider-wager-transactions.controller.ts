import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  GetWagerTransactionService,
  WagerTransactionNotFoundError,
} from '../application/get-wager-transaction.service.js';
import { toWagerTransactionResponse } from './wager-transaction-response.js';

@Controller('providers/:providerId/wagering/transactions')
export class ProviderWagerTransactionsController {
  constructor(private readonly getTransactions: GetWagerTransactionService) {}

  @Get(':externalTransactionId')
  async getByProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    try {
      return toWagerTransactionResponse(
        await this.getTransactions.byProviderExternalId(
          providerId,
          externalTransactionId,
        ),
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
}
