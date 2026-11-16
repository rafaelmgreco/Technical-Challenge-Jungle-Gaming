import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  HttpStatus,
  NotFoundException,
  Post,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CreateWalletService, WalletAlreadyExistsError } from '../application/create-wallet.service.js';
import {
  ReconcileWalletService,
  WalletNotFoundForReconciliationError,
} from '../application/reconcile-wallet.service.js';
import { Money } from '../domain/money/money.js';

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException({
      code: 'INVALID_REQUEST',
      message: `${field} must be a non-empty string`,
    });
  }
  return value;
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletService,
    private readonly reconcileWallet: ReconcileWalletService,
  ) {}

  @Post(':walletId/reconciliation')
  async reconcile(
    @Param('walletId') walletId: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.reconcileWallet.reconcile(walletId);
    } catch (error) {
      if (error instanceof WalletNotFoundForReconciliationError) {
        throw new NotFoundException({
          code: 'WALLET_NOT_FOUND',
          message: error.message,
        });
      }
      throw error;
    }
  }

  @Post()
  async create(
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Request body must be a JSON object' });
    }
    const body = rawBody as Record<string, unknown>;
    if (body.initialBalance === null || typeof body.initialBalance !== 'object' || Array.isArray(body.initialBalance)) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'initialBalance must contain amount and currency' });
    }
    const balance = body.initialBalance as Record<string, unknown>;

    let initialBalance: Money;
    try {
      initialBalance = Money.from({
        amount: requiredString(balance.amount, 'initialBalance.amount'),
        currency: requiredString(balance.currency, 'initialBalance.currency'),
      });
    } catch (error) {
      throw new BadRequestException({
        code: 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : 'initialBalance is invalid',
      });
    }

    const playerId = requiredString(body.playerId, 'playerId');
    try {
      const wallet = await this.createWallet.create(playerId, initialBalance);
      response.status(HttpStatus.CREATED);
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException({ code: 'WALLET_ALREADY_EXISTS', message: error.message });
      }
      throw error;
    }
  }
}
