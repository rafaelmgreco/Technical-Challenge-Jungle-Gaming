import { Injectable } from '@nestjs/common';
import type { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction.js';

export type TransactionMetricSource = 'http' | 'sqs';
export type RetryMetricSource = 'sqs' | 'outbox' | 'pending_reference';

const TRANSACTION_STATUSES = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
] as const;
const TRANSACTION_SOURCES = ['http', 'sqs'] as const;
const RETRY_SOURCES = ['sqs', 'outbox', 'pending_reference'] as const;
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

@Injectable()
export class MetricsRegistry {
  private readonly transactionCounts = new Map<string, number>();
  private readonly retryCounts = new Map<RetryMetricSource, number>(
    RETRY_SOURCES.map((source) => [source, 0]),
  );
  private duplicateCount = 0;
  private dlqRedriveCount = 0;
  private lockConflictCount = 0;
  private outboxLagSeconds = 0;
  private readonly latencyBucketCounts = LATENCY_BUCKETS.map(() => 0);
  private latencyCount = 0;
  private latencySumSeconds = 0;

  recordTransaction(
    status: WagerTransactionStatus,
    source: TransactionMetricSource,
  ): void {
    const key = `${source}:${status}`;
    this.transactionCounts.set(key, (this.transactionCounts.get(key) ?? 0) + 1);
  }

  recordDuplicate(): void {
    this.duplicateCount += 1;
  }

  recordRetry(source: RetryMetricSource): void {
    this.retryCounts.set(source, (this.retryCounts.get(source) ?? 0) + 1);
  }

  recordDlqRedrive(): void {
    this.dlqRedriveCount += 1;
  }

  recordLockConflict(): void {
    this.lockConflictCount += 1;
  }

  setOutboxLagSeconds(value: number): void {
    this.outboxLagSeconds = Math.max(0, value);
  }

  observeProcessingDurationSeconds(value: number): void {
    const duration = Math.max(0, value);
    this.latencyCount += 1;
    this.latencySumSeconds += duration;
    LATENCY_BUCKETS.forEach((upperBound, index) => {
      if (duration <= upperBound) this.latencyBucketCounts[index] += 1;
    });
  }

  renderPrometheus(): string {
    const lines = [
      '# HELP wager_transaction_submissions_total Submission outcomes by source and status.',
      '# TYPE wager_transaction_submissions_total counter',
    ];
    for (const source of TRANSACTION_SOURCES) {
      for (const status of TRANSACTION_STATUSES) {
        lines.push(
          `wager_transaction_submissions_total{source="${source}",status="${status}"} ${this.transactionCounts.get(`${source}:${status}`) ?? 0}`,
        );
      }
    }
    lines.push(
      '# HELP wager_duplicates_total Requests recognized as persistent duplicates.',
      '# TYPE wager_duplicates_total counter',
      `wager_duplicates_total ${this.duplicateCount}`,
      '# HELP wager_retries_total Retry attempts by processing component.',
      '# TYPE wager_retries_total counter',
    );
    for (const source of RETRY_SOURCES) {
      lines.push(
        `wager_retries_total{source="${source}"} ${this.retryCounts.get(source) ?? 0}`,
      );
    }
    lines.push(
      '# HELP wager_sqs_dlq_redrives_total Messages reaching the configured SQS redrive threshold.',
      '# TYPE wager_sqs_dlq_redrives_total counter',
      `wager_sqs_dlq_redrives_total ${this.dlqRedriveCount}`,
      '# HELP wallet_lock_conflicts_total PostgreSQL deadlocks or lock-unavailable errors.',
      '# TYPE wallet_lock_conflicts_total counter',
      `wallet_lock_conflicts_total ${this.lockConflictCount}`,
      '# HELP integration_event_outbox_lag_seconds Age of the oldest event claimed in the latest poll.',
      '# TYPE integration_event_outbox_lag_seconds gauge',
      `integration_event_outbox_lag_seconds ${formatNumber(this.outboxLagSeconds)}`,
      '# HELP wager_processing_duration_seconds End-to-end transaction submission duration.',
      '# TYPE wager_processing_duration_seconds histogram',
    );
    LATENCY_BUCKETS.forEach((upperBound, index) => {
      lines.push(
        `wager_processing_duration_seconds_bucket{le="${upperBound}"} ${this.latencyBucketCounts[index]}`,
      );
    });
    lines.push(
      `wager_processing_duration_seconds_bucket{le="+Inf"} ${this.latencyCount}`,
      `wager_processing_duration_seconds_sum ${formatNumber(this.latencySumSeconds)}`,
      `wager_processing_duration_seconds_count ${this.latencyCount}`,
    );
    return `${lines.join('\n')}\n`;
  }
}

export const PROMETHEUS_CONTENT_TYPE =
  'text/plain; version=0.0.4; charset=utf-8';
