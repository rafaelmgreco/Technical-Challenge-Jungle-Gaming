import type { WagerTransaction } from '../domain/wager-transaction/wager-transaction.js';

export function toWagerTransactionResponse(
  transaction: WagerTransaction,
): Record<string, unknown> {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    ...(transaction.referenceExternalTransactionId
      ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
      : {}),
    ...(transaction.referenceTransactionId
      ? { referenceTransactionId: transaction.referenceTransactionId }
      : {}),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    ...(transaction.processedAt
      ? { processedAt: transaction.processedAt.toISOString() }
      : {}),
    ...(transaction.processedBalance
      ? { balance: transaction.processedBalance.toJSON() }
      : {}),
    createdAt: transaction.createdAt.toISOString(),
  };
}
