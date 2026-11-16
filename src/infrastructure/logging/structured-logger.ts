export type StructuredLogLevel = 'info' | 'warn' | 'error';

export interface StructuredLogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  externalTransactionId?: string;
  eventId?: string;
}

export interface StructuredLogEntry extends StructuredLogContext {
  timestamp: string;
  level: StructuredLogLevel;
  event: string;
  errorName?: string;
}

export function createStructuredLogEntry(
  level: StructuredLogLevel,
  event: string,
  context: StructuredLogContext = {},
  occurredAt = new Date(),
  error?: unknown,
): StructuredLogEntry {
  const errorName =
    error instanceof Error
      ? error.name
      : error === undefined
        ? undefined
        : 'UnknownError';
  return {
    timestamp: occurredAt.toISOString(),
    level,
    event,
    ...context,
    ...(errorName ? { errorName } : {}),
  };
}

export class StructuredLogger {
  info(event: string, context: StructuredLogContext = {}): void {
    console.log(JSON.stringify(createStructuredLogEntry('info', event, context)));
  }

  warn(
    event: string,
    context: StructuredLogContext = {},
    error?: unknown,
  ): void {
    console.warn(
      JSON.stringify(
        createStructuredLogEntry('warn', event, context, new Date(), error),
      ),
    );
  }

  error(
    event: string,
    context: StructuredLogContext = {},
    error?: unknown,
  ): void {
    console.error(
      JSON.stringify(
        createStructuredLogEntry('error', event, context, new Date(), error),
      ),
    );
  }
}
