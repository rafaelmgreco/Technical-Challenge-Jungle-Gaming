import { describe, expect, it } from 'bun:test';
import { createStructuredLogEntry } from '../src/infrastructure/logging/structured-logger.js';

describe('structured logs', () => {
  it('keeps operational identifiers and excludes error messages and financial values', () => {
    const entry = createStructuredLogEntry(
      'error',
      'wager_transaction_message_failed',
      {
        correlationId: 'provider:external-1',
        messageId: 'message-1',
        transactionId: 'transaction-1',
        walletId: 'wallet-1',
        providerId: 'provider',
      },
      new Date('2026-11-16T12:00:00.000Z'),
      new Error('failure with amount 999.00'),
    );

    expect(entry).toEqual({
      timestamp: '2026-11-16T12:00:00.000Z',
      level: 'error',
      event: 'wager_transaction_message_failed',
      correlationId: 'provider:external-1',
      messageId: 'message-1',
      transactionId: 'transaction-1',
      walletId: 'wallet-1',
      providerId: 'provider',
      errorName: 'Error',
    });
    expect(JSON.stringify(entry)).not.toContain('999.00');
  });
});
