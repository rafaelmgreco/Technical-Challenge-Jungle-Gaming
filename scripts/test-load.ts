import { cpus, freemem, totalmem } from 'node:os';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../src/infrastructure/database/mikro-orm.config.js';

interface RequestResult {
  status: number | null;
  elapsedMs: number;
  error?: string;
}

interface MetricsSnapshot {
  httpSubmissions: number;
  lockConflicts: number;
  outboxLagSeconds: number;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function decimalToMinorUnits(value: string): bigint {
  const match = /^(0|[1-9]\d*)\.(\d{2})$/.exec(value);
  if (!match)
    throw new Error('LOAD_BET_AMOUNT must use a decimal string such as 1.00');
  return BigInt(match[1]!) * 100n + BigInt(match[2]!);
}

function minorUnitsToDecimal(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

function metric(text: string, name: string): number {
  const match = new RegExp(`^${name}\\s+([0-9.eE+-]+)$`, 'm').exec(text);
  return match ? Number(match[1]) : 0;
}

function httpSubmissionMetric(text: string): number {
  const rows = text.matchAll(
    /^wager_transaction_submissions_total\{source="http",status="[A-Z_]+"\}\s+([0-9.eE+-]+)$/gm,
  );
  return [...rows].reduce((total, row) => total + Number(row[1]), 0);
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1]!;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const baseUrl = (
    process.env.LOAD_BASE_URL ?? 'http://localhost:3000'
  ).replace(/\/$/, '');
  const requestCount = positiveInteger('LOAD_REQUESTS', 100);
  const concurrency = positiveInteger('LOAD_CONCURRENCY', 10);
  const drainSeconds = positiveInteger('LOAD_DRAIN_SECONDS', 25);
  const betAmount = process.env.LOAD_BET_AMOUNT ?? '1.00';
  const betMinorUnits = decimalToMinorUnits(betAmount);
  const runId = crypto.randomUUID();
  const playerId = `load-test-${runId}`;
  const startedAt = new Date();
  let walletId: string | undefined;
  let orm: MikroORM | undefined;
  let samplerRunning = false;
  let sampler: Promise<void> | undefined;
  const metricSamples: MetricsSnapshot[] = [];
  const results: RequestResult[] = Array.from({ length: requestCount });

  const fetchMetrics = async (): Promise<MetricsSnapshot> => {
    const response = await fetch(`${baseUrl}/metrics`);
    if (!response.ok)
      throw new Error(`GET /metrics returned ${response.status}`);
    const text = await response.text();
    return {
      httpSubmissions: httpSubmissionMetric(text),
      lockConflicts: metric(text, 'wallet_lock_conflicts_total'),
      outboxLagSeconds: metric(text, 'integration_event_outbox_lag_seconds'),
    };
  };

  let baseline: MetricsSnapshot | undefined;
  let postgresVersion = 'unavailable';
  let runError: unknown;

  try {
    const readiness = await fetch(`${baseUrl}/health/ready`);
    if (!readiness.ok) {
      throw new Error(`GET /health/ready returned ${readiness.status}`);
    }
    baseline = await fetchMetrics();

    orm = await MikroORM.init(mikroOrmConfig);
    const database = await orm.em
      .getConnection()
      .execute<{ version: string }[]>('select version() as version');
    postgresVersion = database[0]?.version ?? 'unknown';

    const createWalletResponse = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: {
          amount: minorUnitsToDecimal(betMinorUnits * BigInt(requestCount)),
          currency: 'BRL',
        },
      }),
    });
    const createdWallet = (await createWalletResponse.json()) as {
      id?: string;
      message?: string;
    };
    if (!createWalletResponse.ok || !createdWallet.id) {
      throw new Error(
        `POST /wallets returned ${createWalletResponse.status}: ${createdWallet.message ?? 'wallet ID missing'}`,
      );
    }
    walletId = createdWallet.id;

    samplerRunning = true;
    sampler = (async () => {
      while (samplerRunning) {
        try {
          metricSamples.push(await fetchMetrics());
        } catch {
          // The final sample below reports the current metrics endpoint state.
        }
        await wait(500);
      }
    })();

    let nextRequest = 0;
    const requestWorker = async (): Promise<void> => {
      while (true) {
        const index = nextRequest;
        nextRequest += 1;
        if (index >= requestCount) return;

        const externalTransactionId = `${runId}-${index}`;
        const requestStarted = performance.now();
        try {
          const response = await fetch(`${baseUrl}/wagering/transactions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `load-test:${externalTransactionId}`,
            },
            body: JSON.stringify({
              providerId: 'load-test',
              externalTransactionId,
              playerId,
              walletId,
              roundId: `load-test-${runId}`,
              gameId: 'load-test',
              kind: 'BET',
              money: { amount: betAmount, currency: 'BRL' },
            }),
          });
          results[index] = {
            status: response.status,
            elapsedMs: performance.now() - requestStarted,
          };
          await response.body?.cancel();
        } catch (error) {
          results[index] = {
            status: null,
            elapsedMs: performance.now() - requestStarted,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    };

    const loadStarted = performance.now();
    await Promise.all(
      Array.from({ length: Math.min(concurrency, requestCount) }, () =>
        requestWorker(),
      ),
    );
    const loadElapsedMs = performance.now() - loadStarted;

    await wait(drainSeconds * 1_000);
    samplerRunning = false;
    await sampler;
    metricSamples.push(await fetchMetrics());

    const finalMetrics = metricSamples.at(-1)!;
    const successful = results.filter((result) => result.status === 201);
    const failed = results.filter((result) => result.status !== 201);
    const latencies = results.map((result) => result.elapsedMs);
    const statusCounts = results.reduce<Record<string, number>>(
      (counts, result) => {
        const key =
          result.status === null ? 'network_error' : String(result.status);
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      },
      {},
    );
    const maxObservedOutboxLag = Math.max(
      0,
      ...metricSamples.map((sample) => sample.outboxLagSeconds),
    );

    const pendingOutbox = await orm.em
      .getConnection()
      .execute<{ count: number }[]>(
        `select count(*)::int as count
       from "integration_event_outbox" as outbox
       join "wager_transactions" as wager
         on wager."id" = outbox."aggregate_id"
       where wager."wallet_id" = ? and outbox."published_at" is null`,
        [walletId],
      );
    const pendingOutboxCount = pendingOutbox[0]?.count ?? 0;

    console.log(
      JSON.stringify(
        {
          runId,
          startedAt: startedAt.toISOString(),
          environment: {
            bunVersion: Bun.version,
            platform: process.platform,
            architecture: process.arch,
            cpuModel: cpus()[0]?.model ?? 'unknown',
            cpuCount: cpus().length,
            totalMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)),
            freeMemoryGiB: Number((freemem() / 1024 ** 3).toFixed(2)),
            postgresVersion,
            baseUrl,
          },
          methodology: {
            scenario: 'unique BET requests contending on one wallet',
            requests: requestCount,
            concurrency,
            betAmount,
            walletInitialBalance: minorUnitsToDecimal(
              betMinorUnits * BigInt(requestCount),
            ),
            outboxDrainSeconds: drainSeconds,
          },
          results: {
            elapsedSeconds: Number((loadElapsedMs / 1_000).toFixed(3)),
            throughputRequestsPerSecond: Number(
              (requestCount / (loadElapsedMs / 1_000)).toFixed(2),
            ),
            succeeded: successful.length,
            failed: failed.length,
            errorRatePercent: Number(
              ((failed.length / requestCount) * 100).toFixed(2),
            ),
            responseStatuses: statusCounts,
            latencyMs: {
              p50: Number(percentile(latencies, 0.5).toFixed(2)),
              p95: Number(percentile(latencies, 0.95).toFixed(2)),
              p99: Number(percentile(latencies, 0.99).toFixed(2)),
            },
            lockConflictDelta:
              finalMetrics.lockConflicts - baseline.lockConflicts,
            httpSubmissionMetricDelta:
              finalMetrics.httpSubmissions - baseline.httpSubmissions,
            outboxLagSeconds: {
              maxSampled: Number(maxObservedOutboxLag.toFixed(3)),
              finalSample: Number(finalMetrics.outboxLagSeconds.toFixed(3)),
              sampleCount: metricSamples.length,
              pendingEventsForRun: pendingOutboxCount,
            },
          },
        },
        null,
        2,
      ),
    );

    if (failed.length > 0) process.exitCode = 1;
  } catch (error) {
    runError = error;
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    samplerRunning = false;
    await sampler;

    if (orm && walletId && runError === undefined) {
      const pending = await orm.em.getConnection().execute<{ count: number }[]>(
        `select count(*)::int as count
         from "integration_event_outbox" as outbox
         join "wager_transactions" as wager
           on wager."id" = outbox."aggregate_id"
         where wager."wallet_id" = ? and outbox."published_at" is null`,
        [walletId],
      );
      if ((pending[0]?.count ?? 0) === 0 && process.exitCode !== 1) {
        await orm.em
          .getConnection()
          .execute(
            'delete from "integration_event_outbox" where "aggregate_id" in (select "id" from "wager_transactions" where "wallet_id" = ?)',
            [walletId],
          );
        await orm.em
          .getConnection()
          .execute(
            'delete from "wallet_ledger_entries" where "wallet_id" = ?',
            [walletId],
          );
        await orm.em
          .getConnection()
          .execute('delete from "wager_transactions" where "wallet_id" = ?', [
            walletId,
          ]);
        await orm.em
          .getConnection()
          .execute('delete from "wallets" where "id" = ?', [walletId]);
      } else {
        console.error(
          `Load-test records for wallet ${walletId} were retained because requests failed or outbox events remain pending.`,
        );
      }
    }
    if (orm) await orm.close(true);
  }
}

await main();
