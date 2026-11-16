# Distributed Wagering Processor

Project for the [Jungle Gaming backend challenge](https://github.com/junglegaming/backend-challenge).

## Stack

- Bun 1.x as the runtime, package manager, and test runner
- TypeScript with strict mode enabled
- NestJS
- PostgreSQL
- AWS SQS via LocalStack or MiniStack
- Docker Compose
- MikroORM

## Current status

The challenge implementation includes the wallet and wager domain, exact decimal money handling, persistent idempotency, immutable ledger entries, PostgreSQL constraints and migrations, HTTP read/write endpoints, wallet reconciliation, and pessimistically locked financial transactions. It also includes SQS inbox/outbox processing, redelivery and DLQ handling, out-of-order reference retries, operational logs and metrics, health checks, and integration coverage for concurrency and recovery scenarios.

## Getting started

```bash
bun install
Copy-Item .env.example .env
bun run db:up
bun run db:migrate
bun run sqs:up
bun run start:dev
```

The application responds at `http://localhost:3000/`.

The wallet endpoint is `POST /wallets`. The provider endpoint is `POST /wagering/transactions` and requires an `Idempotency-Key` header. The current HTTP version processes `BET`, `WIN`, `LOSS`, `REFUND`, and `ROLLBACK`. A `WIN` may reference a processed `BET` with a different amount; a `REFUND` must reference a processed `BET` for the same amount, and each bet can be refunded only once. A `ROLLBACK` must match the referenced processed transaction's amount and reverses its ledger direction once. When a reference is not available yet, the API stores the transaction as `PENDING_REFERENCE` and returns `202 Accepted` without changing the balance.

The local PostgreSQL instance uses port `5432`. The default credentials are for local development only; update `.env` if needed.

## Tests

```bash
bun test
bun run test:e2e
bun run sqs:up
bun run test:sqs
bun run test:load
```

`bun run test:load` runs an optional, bounded load experiment against the local API. Start PostgreSQL and MiniStack, apply migrations, then start the application in another terminal before running it. By default, it sends 100 unique `BET` requests at concurrency 10 to one BRL wallet with enough balance for all requests, then samples metrics for 25 seconds so the integration-event outbox can drain. It prints one JSON report with the runtime, operating system, CPU and memory, PostgreSQL version, scenario parameters, throughput, success/error rates, response codes, p50/p95/p99 latency, lock-conflict counter delta, HTTP submission counter delta, sampled outbox lag, and pending events for the run.

Tune the experiment with `LOAD_BASE_URL`, `LOAD_REQUESTS`, `LOAD_CONCURRENCY`, `LOAD_DRAIN_SECONDS`, and `LOAD_BET_AMOUNT` environment variables. `LOAD_BET_AMOUNT` must be a decimal string with two fractional digits, such as `1.00`. The script creates a uniquely named wallet and deletes its test records after all requests succeed and its outbox events are published; if requests fail or events remain pending, it retains those records and reports the wallet ID for inspection. Results describe the machine and local service setup used for that run; there is no target RPS.

### Recorded local run

Run on 2026-11-16 with Bun 1.4.4 on Windows x64, an Intel Core i5-9400F (6 logical CPUs), and 15.94 GiB of memory (2.25 GiB free at measurement time). PostgreSQL 17.12 ran in the project Docker Compose setup, with MiniStack 1.5.41 and one local API process. The scenario used the default 100 unique `BET` requests, concurrency 10, `BRL 1.00` per request, and a `BRL 100.00` wallet balance, followed by 25 seconds of outbox sampling.

| Measure                                 |                      Result |
| --------------------------------------- | --------------------------: |
| Request phase duration                  |                     1.855 s |
| Throughput                              |            53.92 requests/s |
| Successful / failed                     |                     100 / 0 |
| Error rate                              |                          0% |
| Latency p50 / p95 / p99                 | 167.56 / 298.67 / 393.11 ms |
| Wallet lock conflict counter delta      |                           0 |
| Outbox lag, maximum sampled / final     |                18.385 / 0 s |
| Pending events for this run after drain |                           0 |

This is one local measurement, not a capacity claim. Host load, emulator behavior, and the single-process setup affect the result.

PostgreSQL and MiniStack are not started automatically by the test runner. If `.env` does not exist, create it from `.env.example`, then start both services before running the integration suite:

```powershell
Copy-Item .env.example .env
bun run db:up
bun run sqs:up
bun run test:e2e
```

The SQS-dependent tests are conditionally skipped when their endpoint variables are missing: the readiness test requires `SQS_QUEUE_URL`, the integration-event publisher tests require both `SQS_ENDPOINT_URL` and `SQS_QUEUE_URL`, and the wager consumer tests require `SQS_ENDPOINT_URL`. With the example `.env` loaded and MiniStack running, those tests run against the local queues instead of being skipped. PostgreSQL integration tests require the database to be running.

The current tests cover the application scaffold, liveness and readiness checks, Prometheus metrics exposition and collection, structured log fields and redaction, the rules for `Money`, `Wallet`, `WagerTransaction`, and the ledger, wallet creation and lookup, ledger cursor pagination, transaction lookup by internal and provider IDs, 50 concurrent identical transaction submissions producing one debit, independent concurrent submissions for different wallets, competing wallet debits across three independent application instances, balance reconciliation, persistence and idempotent replay after an application restart, database constraints, repository persistence, inbox duplicate and payload-conflict detection, versioned integration event envelope serialization, SQS redelivery after an acknowledgement failure following the financial commit, graceful SQS consumer shutdown after an in-flight message completes, SQS DLQ redrive, lock-conflict metric collection, idempotent retries and conflicts, referenced wins, refunds delivered before their referenced bets, pending-reference retries and exhaustion, pending, rejection, processed, and balance-change outbox events, concurrent outbox claims and retry scheduling, outbox takeover after a publisher lease expires, single-use refunds and rollbacks, rollback insufficient-funds rejection, and concurrent wallet movements and refunds in PostgreSQL. Start the database with `bun run db:up` before running the tests.

The outbox publisher sends versioned integration event envelopes to the `jungle-integration-events` SQS queue. The public envelope excludes database-only retry metadata; see [ARCHITECTURE.md](./ARCHITECTURE.md) for the envelope and event data contract. `bun run sqs:up` starts MiniStack and also provisions the FIFO `wager-transactions.fifo` input queue and its DLQ. The SQS consumer reuses the HTTP transaction submission use case, stores message IDs in the persistent inbox, and deletes messages only after processing commits. Five failed receives move a message to `wager-transactions-dlq.fifo`. The example `.env` configures both queues. Use `bun run sqs:logs` to inspect the emulator and `bun run sqs:down` to stop it.

The selected `WagerTransaction` state transitions are documented in [ARCHITECTURE.md](./ARCHITECTURE.md).
