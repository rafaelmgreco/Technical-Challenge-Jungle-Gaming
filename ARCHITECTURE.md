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

Failure codes are stable, uppercase, machine-readable strings. The implemented financial rejection codes include `INSUFFICIENT_FUNDS`, `INVALID_REFERENCE`, `REFERENCE_ALREADY_REVERSED`, and `ROLLBACK_INSUFFICIENT_FUNDS`.

Wager transactions are persisted with their provider identity, idempotency key, payload hash, wallet, amount, status, and processing result. PostgreSQL enforces unique idempotency keys and external transaction IDs per provider. The movement service processes `BET` debits, `WIN` credits, `REFUND` credits, and `ROLLBACK` in the opposite direction of its reference. A `WIN` may reference an already processed `BET`; the provider, player, wallet, currency, and round must match, but the amount may differ. A `REFUND` must match those same fields and the bet amount, and each processed bet can be refunded only once. A `ROLLBACK` must match the referenced `BET`, `WIN`, or `REFUND` amount and each processed transaction can be rolled back only once. The wallet lock serializes competing reversals, and partial unique indexes protect both invariants in PostgreSQL. A rollback debit that would make the balance negative is rejected with `ROLLBACK_INSUFFICIENT_FUNDS`. `LOSS` is recorded with the wallet balance captured at processing time, without changing the wallet or creating a ledger entry; this snapshot keeps replay responses stable if later movements change the balance. Out-of-order reference handling is still pending.

Registration treats a retry with the same provider, idempotency key, and payload hash as the original transaction and returns that stored transaction. Reusing the key with a different payload, or reusing the provider's external transaction ID with a different key, is a conflict. Concurrent identical registrations converge on one database row.

## HTTP provider endpoint

`POST /wagering/transactions` requires the `Idempotency-Key` header. The payload hash is SHA-256 over canonical JSON of the business fields (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, normalized `money`, and optional `referenceExternalTransactionId`), with object keys sorted recursively; the header is excluded. The current endpoint processes `BET`, `WIN`, `LOSS`, `REFUND`, and `ROLLBACK`; `WIN` and `REFUND` can reference an already processed `BET`, and `ROLLBACK` can reference an already processed `BET`, `WIN`, or `REFUND`. It returns `201` for a new processed transaction, `200` for a processed replay, `409` for an idempotency or external-ID conflict, and `422` for a business rejection or unsupported operation.

Authentication is not implemented in this local challenge prototype. Before external exposure, the controller should use a `ProviderIdentityPort` backed by an external OIDC identity provider; health endpoints can remain public.

`POST /wallets` accepts `playerId` and an `initialBalance` decimal string with an ISO-4217 currency. A second wallet for the same player and currency returns a conflict; the same player can have wallets in different currencies.

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

## Pending decisions

- Queue and reprocess out-of-order references.
- Define the local SQS emulator and retry and DLQ policies.

## Local persistence

PostgreSQL runs through Docker Compose, with its port bound to `127.0.0.1`. NestJS uses MikroORM 7 with the PostgreSQL driver. Reversible migrations create `wallets`, `wallet_ledger_entries`, and `wager_transactions`. Wallet balances, transaction amounts, ledger amounts, and balance snapshots use minor units as `BIGINT`; constraints protect wallet and transaction currencies, provider idempotency, transaction identity, ledger uniqueness, balanced entries, and single-use refunds and rollbacks. Integration tests validate the schema, repository round-trips, transaction rollback, and concurrent wallet movements against PostgreSQL.
