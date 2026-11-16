import { describe, expect, it } from 'bun:test';
import { WagerTransactionStatus } from '../src/domain/wager-transaction/wager-transaction.js';
import { MetricsRegistry } from '../src/infrastructure/metrics/metrics.registry.js';

describe('Prometheus metrics registry', () => {
  it('renders transaction, duplicate, retry, DLQ, lock, lag, and latency metrics', () => {
    const metrics = new MetricsRegistry();
    metrics.recordTransaction(WagerTransactionStatus.Processed, 'http');
    metrics.recordDuplicate();
    metrics.recordRetry('sqs');
    metrics.recordDlqRedrive();
    metrics.recordLockConflict();
    metrics.setOutboxLagSeconds(3.5);
    metrics.observeProcessingDurationSeconds(0.03);

    const output = metrics.renderPrometheus();
    expect(output).toContain(
      'wager_transaction_submissions_total{source="http",status="PROCESSED"} 1',
    );
    expect(output).toContain('wager_duplicates_total 1');
    expect(output).toContain('wager_retries_total{source="sqs"} 1');
    expect(output).toContain('wager_sqs_dlq_redrives_total 1');
    expect(output).toContain('wallet_lock_conflicts_total 1');
    expect(output).toContain('integration_event_outbox_lag_seconds 3.5');
    expect(output).toContain(
      'wager_processing_duration_seconds_bucket{le="0.05"} 1',
    );
    expect(output).toContain('wager_processing_duration_seconds_count 1');
  });
});
