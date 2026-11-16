import { Inject, Injectable } from '@nestjs/common';
import type { WalletLedgerEntry } from '../domain/ledger/ledger-entry.js';
import {
  WALLET_UNIT_OF_WORK,
  type WalletUnitOfWork,
} from './ports/wallet-unit-of-work.js';
import { WalletNotFoundError } from './get-wallet.service.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export class InvalidLedgerCursorError extends Error {
  constructor() {
    super('Ledger cursor is invalid');
    this.name = 'InvalidLedgerCursorError';
  }
}

export class InvalidLedgerPageSizeError extends Error {
  constructor() {
    super(`Ledger page size must be between 1 and ${MAX_PAGE_SIZE}`);
    this.name = 'InvalidLedgerPageSizeError';
  }
}

function decodeCursor(cursor: string | undefined): LedgerCursor | undefined {
  if (cursor === undefined) return undefined;

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('createdAt' in parsed) ||
      !('id' in parsed) ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      parsed.id.length === 0
    ) {
      throw new InvalidLedgerCursorError();
    }
    const createdAt = new Date(parsed.createdAt);
    if (
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== parsed.createdAt
    ) {
      throw new InvalidLedgerCursorError();
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new InvalidLedgerCursorError();
  }
}

function encodeCursor(entry: WalletLedgerEntry): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: entry.createdAt.toISOString(),
      id: entry.id,
    }),
  ).toString('base64url');
}

@Injectable()
export class GetWalletLedgerPageService {
  constructor(
    @Inject(WALLET_UNIT_OF_WORK)
    private readonly unitOfWork: WalletUnitOfWork,
  ) {}

  async getPage(input: {
    walletId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    walletId: string;
    entries: Array<{
      id: string;
      transactionId: string;
      direction: string;
      money: ReturnType<WalletLedgerEntry['money']['toJSON']>;
      balanceBefore: ReturnType<WalletLedgerEntry['balanceBefore']['toJSON']>;
      balanceAfter: ReturnType<WalletLedgerEntry['balanceAfter']['toJSON']>;
      createdAt: string;
    }>;
    nextCursor: string | null;
  }> {
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new InvalidLedgerPageSizeError();
    }

    const after = decodeCursor(input.cursor);
    return this.unitOfWork.execute(async ({ wallets, ledger }) => {
      const wallet = await wallets.findById(input.walletId);
      if (!wallet) throw new WalletNotFoundError(input.walletId);

      const rows = await ledger.findByWalletPage(
        wallet.id,
        after,
        limit + 1,
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        walletId: wallet.id,
        entries: page.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: hasMore && last ? encodeCursor(last) : null,
      };
    });
  }
}
