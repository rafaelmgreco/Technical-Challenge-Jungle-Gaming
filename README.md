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

The repository is in its early stages. It contains a minimal NestJS application, the `Money` value object, the `Wallet` aggregate, a wallet creation endpoint with an atomic `OPENING` entry, persisted wager transactions with idempotent registration, immutable ledger entries, PostgreSQL migrations, MikroORM repositories, and atomic `BET`/`WIN`/`REFUND`/`ROLLBACK` wallet processing with a pessimistic row lock. `LOSS` transactions are recorded without changing the wallet balance or creating a ledger entry. `WIN` and `REFUND` can reference an already processed `BET`; `ROLLBACK` can reverse a processed `BET`, `WIN`, or `REFUND`. Unavailable references are persisted as `PENDING_REFERENCE` and retried by a scheduled database worker with exponential backoff.

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
```

The current tests cover the application scaffold, liveness and readiness checks, Prometheus metrics exposition and collection, structured log fields and redaction, the rules for `Money`, `Wallet`, `WagerTransaction`, and the ledger, wallet creation and lookup, ledger cursor pagination, transaction lookup by internal and provider IDs, 50 concurrent identical transaction submissions producing one debit, independent concurrent submissions for different wallets, competing wallet debits across three independent application instances, balance reconciliation, database constraints, repository persistence, inbox duplicate and payload-conflict detection, versioned integration event envelope serialization, SQS redelivery and DLQ redrive, lock-conflict metric collection, idempotent retries and conflicts, referenced wins, pending-reference retries and exhaustion, pending, rejection, processed, and balance-change outbox events, concurrent outbox claims and retry scheduling, single-use refunds and rollbacks, rollback insufficient-funds rejection, and concurrent wallet movements and refunds in PostgreSQL. Start the database with `bun run db:up` before running the tests.

The outbox publisher sends versioned integration event envelopes to the `jungle-integration-events` SQS queue. The public envelope excludes database-only retry metadata; see [ARCHITECTURE.md](./ARCHITECTURE.md) for the envelope and event data contract. `bun run sqs:up` starts MiniStack and also provisions the FIFO `wager-transactions.fifo` input queue and its DLQ. The SQS consumer reuses the HTTP transaction submission use case, stores message IDs in the persistent inbox, and deletes messages only after processing commits. Five failed receives move a message to `wager-transactions-dlq.fifo`. The example `.env` configures both queues. Use `bun run sqs:logs` to inspect the emulator and `bun run sqs:down` to stop it.

The selected `WagerTransaction` state transitions are documented in [ARCHITECTURE.md](./ARCHITECTURE.md).
