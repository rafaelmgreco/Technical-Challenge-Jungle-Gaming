import { describe, expect, it } from 'bun:test';
import {
  serializeIntegrationEvent,
  toIntegrationEventEnvelope,
} from '../src/infrastructure/messaging/integration-event-envelope.js';

describe('integration event envelope', () => {
  it('serializes the versioned public contract without outbox delivery metadata', () => {
    const occurredAt = new Date('2026-11-16T12:00:00.000Z');
    const event = {
      id: 'event-1',
      aggregateId: 'transaction-1',
      eventType: 'WalletBalanceChanged' as const,
      version: 1 as const,
      correlationId: 'provider:external-1',
      causationId: 'transaction-1',
      occurredAt,
      data: {
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
      attempts: 4,
    };

    expect(toIntegrationEventEnvelope(event)).toEqual({
      id: 'event-1',
      aggregateId: 'transaction-1',
      eventType: 'WalletBalanceChanged',
      version: 1,
      correlationId: 'provider:external-1',
      causationId: 'transaction-1',
      occurredAt: '2026-11-16T12:00:00.000Z',
      data: event.data,
    });
    expect(JSON.parse(serializeIntegrationEvent(event))).not.toHaveProperty(
      'attempts',
    );
  });

  it('omits causationId when an event has no cause', () => {
    const envelope = toIntegrationEventEnvelope({
      id: 'event-2',
      aggregateId: 'transaction-2',
      eventType: 'WagerTransactionProcessed',
      version: 1,
      correlationId: 'provider:external-2',
      occurredAt: new Date('2026-11-16T12:00:00.000Z'),
      data: {},
    });

    expect(envelope).not.toHaveProperty('causationId');
  });
});
