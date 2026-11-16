# Architecture decisions

This document records decisions as they are implemented. Decisions that are not implemented yet are listed as pending.

## WagerTransaction

A transaction starts in `PENDING`.

| Current state | Allowed transitions |
| --- | --- |
| `PENDING` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED`, `FAILED` |
| `PROCESSED` | none; terminal |
| `REJECTED` | none; terminal |
| `FAILED` | none; terminal |

`PENDING_REFERENCE` is only allowed when there is an external reference to resolve. Processing a referenced transaction requires associating the internal ID of the referenced transaction.

`REFUND` and `ROLLBACK` require an external reference. `WIN` may have an optional reference. A `LOSS` transaction does not change the balance. All transaction amounts must be positive.

`OPENING` represents only the internal opening credit for a wallet. The HTTP and SQS adapters must reject `OPENING` as a provider-submitted operation.

Failure codes are stable, uppercase, machine-readable strings. The implemented financial rejection codes include `INSUFFICIENT_FUNDS`, `INVALID_REFERENCE`, `REFERENCE_ALREADY_REVERSED`, `REFERENCE_NOT_FOUND`, and `ROLLBACK_INSUFFICIENT_FUNDS`.

Wager transactions are persisted with their provider identity, idempotency key, payload hash, wallet, amount, status, and processing result. PostgreSQL enforces unique idempotency keys and external transaction IDs per provider. The movement service processes `BET` debits, `WIN` credits, `REFUND` credits, and `ROLLBACK` in the opposite direction of its reference. A `WIN` may reference an already processed `BET`; the provider, player, wallet, currency, and round must match, but the amount may differ. A `REFUND` must match those same fields and the bet amount, and each processed bet can be refunded only once. A `ROLLBACK` must match the referenced `BET`, `WIN`, or `REFUND` amount and each processed transaction can be rolled back only once. The wallet lock serializes competing reversals, and partial unique indexes protect both invariants in PostgreSQL. A rollback debit that would make the balance negative is rejected with `ROLLBACK_INSUFFICIENT_FUNDS`. `LOSS` is recorded with the wallet balance captured at processing time, without changing the wallet or creating a ledger entry; this snapshot keeps replay responses stable if later movements change the balance. Every processed transaction, including `LOSS` and internal `OPENING`, emits `WagerTransactionProcessed`. Transactions that actually change a wallet balance also emit `WalletBalanceChanged`; a `LOSS` emits no balance-change event. A referenced transaction whose source is absent or still processing is stored as `PENDING_REFERENCE`. A scheduled database worker polls every second, reads batches of up to 50 due references, and allows up to five attempts total with delays doubling from one second; it marks exhausted references `REJECTED` with `REFERENCE_NOT_FOUND`. `WagerTransactionPendingReference`, `WagerTransactionRejected`, `WagerTransactionProcessed`, and `WalletBalanceChanged` events are inserted into `integration_event_outbox` in the same SQL transaction as the associated state change.

Registration treats a retry with the same provider, idempotency key, and payload hash as the original transaction and returns that stored transaction. Reusing the key with a different payload, or reusing the provider's external transaction ID with a different key, is a conflict. Concurrent identical registrations converge on one database row.

## HTTP provider endpoint

`POST /wagering/transactions` requires the `Idempotency-Key` header. The payload hash is SHA-256 over canonical JSON of the business fields (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, normalized `money`, and optional `referenceExternalTransactionId`), with object keys sorted recursively; the header is excluded. The current endpoint processes `BET`, `WIN`, `LOSS`, `REFUND`, and `ROLLBACK`; `WIN` and `REFUND` can reference an already processed `BET`, and `ROLLBACK` can reference an already processed `BET`, `WIN`, or `REFUND`. A referenced transaction whose source is missing or still pending is stored as `PENDING_REFERENCE` and returns `202`; no balance or ledger change is made until processing succeeds. The endpoint returns `201` for a new processed transaction, `200` for a processed replay, `409` for an idempotency or external-ID conflict, and `422` for a business rejection or unsupported operation. `GET /wagering/transactions/:transactionId` retrieves by internal ID; `GET /providers/:providerId/wagering/transactions/:externalTransactionId` retrieves by provider identity. Both return `404` when no transaction matches.

Authentication is not implemented in this local challenge prototype. Before external exposure, the controller should use a `ProviderIdentityPort` backed by an external OIDC identity provider; health endpoints can remain public.

`POST /wallets` accepts `playerId` and an `initialBalance` decimal string with an ISO-4217 currency. A second wallet for the same player and currency returns a conflict; the same player can have wallets in different currencies. `GET /wallets/:walletId` returns the stored wallet state or `404`. `GET /wallets/:walletId/ledger` uses keyset pagination ordered by `(createdAt, id)` with a base64url cursor; page size defaults to 50 and is limited to 100. `POST /wallets/:walletId/reconciliation` sums immutable ledger movements, checks their arithmetic and currency, and compares the result with the stored balance. It reports discrepancies without changing financial data.

`GET /health/live` reports that the process can serve requests. `GET /health/ready` checks PostgreSQL with `SELECT 1` and verifies the configured SQS queue with `GetQueueAttributes`; it returns `503` with per-dependency status if either check fails. Both health endpoints are public.

Application processing logs are single-line JSON with an event name, timestamp, level, and allowlisted operational identifiers (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, and related event IDs). Error messages and money values are excluded to avoid copying payload or financial data into logs.

## Ledger

Each `WalletLedgerEntry` is immutable and records the wallet, transaction, direction, amount, previous balance, resulting balance, and creation time. The `create` factory requires matching currencies, a positive amount, non-negative balances, and validates that `previous balance ± amount = resulting balance`. PostgreSQL enforces one entry per wallet and transaction, validates the balance arithmetic, and ensures the ledger currency matches the wallet.

| Transaction | Direction |
| --- | --- |
| `OPENING` | credit |
| `BET` | debit |
| `WIN` | credit |
| `LOSS` | no entry |
| `REFUND` | credit for the referenced `BET` |
| `ROLLBACK` | opposite direction of the referenced `BET`, `WIN`, or `REFUND` |

Financial references must be processed and match the same provider, player, wallet, currency, and round. `REFUND` only accepts a `BET`; `ROLLBACK` accepts a `BET`, `WIN`, or `REFUND`; both require the same amount as the referenced transaction. `WIN` may reference a `BET` without requiring the same amount. `WagerTransaction.ledgerDirectionFor` performs these checks before determining the direction.

## Wallet movement concurrency

Wallet debits and credits run through a unit of work backed by a PostgreSQL transaction. The unit of work locks the wager transaction and wallet, then persists their updated state and the immutable ledger entry atomically. Concurrent movements for the same wallet are serialized with `PESSIMISTIC_WRITE`. An insufficient-funds debit is recorded as `REJECTED` with `INSUFFICIENT_FUNDS`; it does not change the balance or create a ledger entry. Any persistence failure rolls back the entire operation.

Wallet creation also runs in one PostgreSQL transaction. A positive initial balance creates an internal `OPENING` transaction and its matching `CREDIT` ledger entry; a zero balance creates neither. `OPENING` is not accepted by the provider transaction endpoint.

## Integration event contract

The SQS integration event contract is a JSON envelope with `id`, `aggregateId`, `eventType`, `version`, `correlationId`, optional `causationId`, ISO-8601 UTC `occurredAt`, and `data`. `version` identifies the payload schema for the given `eventType`; incompatible changes require a new version, and consumers must deduplicate delivery by `id` and support the event versions they subscribe to. Database-only outbox metadata such as publish attempts is never sent to SQS.

The version 1 event data fields are:

| Event | Data fields |
| --- | --- |
| `WagerTransactionPendingReference` | `transactionId`, `providerId`, `externalTransactionId`, `referenceExternalTransactionId`, `walletId`, `kind` |
| `WagerTransactionRejected` | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `kind`, `failureCode` |
| `WagerTransactionProcessed` | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `kind`, `money`, optional `referenceTransactionId`, and processed `balance` snapshot |
| `WalletBalanceChanged` | `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` |

Every money object uses an exact decimal string and currency code. Delivery remains at least once: consumers must treat repeated event IDs as duplicates. The public envelope is explicitly mapped from the outbox record so persistence-only fields cannot leak into the message.

## Local persistence

PostgreSQL runs through Docker Compose, with its port bound to `127.0.0.1`. NestJS uses MikroORM 7 with the PostgreSQL driver. Reversible migrations create `wallets`, `wallet_ledger_entries`, `wager_transactions`, and `integration_event_outbox`. Wallet balances, transaction amounts, ledger amounts, and balance snapshots use minor units as `BIGINT`; constraints protect wallet and transaction currencies, provider idempotency, transaction identity, ledger uniqueness, balanced entries, and single-use refunds and rollbacks. Integration tests validate the schema, repository round-trips, transaction rollback, and concurrent wallet movements against PostgreSQL.

The outbox worker claims due events with PostgreSQL `FOR UPDATE SKIP LOCKED` and a time-limited lease, publishes outside the SQL transaction, and marks an event published only after SQS accepts the message. Failed sends return to the queue with capped exponential backoff. A crashed worker's lease expires so another process can reclaim the event. This is at-least-once delivery: a crash after SQS accepts a message but before PostgreSQL records publication can produce a duplicate, so consumers must deduplicate by event ID. Set `SQS_QUEUE_URL` to enable polling; `SQS_ENDPOINT_URL` points the AWS SDK at the local MiniStack emulator configured in Docker Compose.

The `inbox_messages` table uses `(consumer_name, message_id)` as its primary key and stores a payload hash with receipt and processing timestamps. Repeated IDs with the same hash are identified as redeliveries; reusing an ID with a different hash is rejected. The persistence port is available through the wallet unit of work so the consumer commits inbox state alongside financial state, ledger entries, and outbox events.

The SQS `WagerTransactionRequested` consumer invokes the same application submission service as HTTP. It records the message in the inbox in the same unit of work as the wallet movement, ledger, and outbox writes, then deletes the broker message after the database commit. Failed processing leaves the message undeleted; the FIFO input queue moves it to its FIFO DLQ after five receives.
