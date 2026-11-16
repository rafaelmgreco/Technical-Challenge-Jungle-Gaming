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

Failure codes are stable, uppercase, machine-readable strings, for example `INSUFFICIENT_FUNDS`. The financial processing use cases will define the specific failure codes.

## Ledger

Each `WalletLedgerEntry` is immutable and records the wallet, transaction, direction, amount, previous balance, resulting balance, and creation time. The `create` factory requires matching currencies, a positive amount, non-negative balances, and validates that `previous balance ± amount = resulting balance`. A PostgreSQL constraint will enforce one entry per wallet and transaction.

| Transaction | Direction |
| --- | --- |
| `OPENING` | credit |
| `BET` | debit |
| `WIN` | credit |
| `LOSS` | no entry |
| `REFUND` | credit for the referenced `BET` |
| `ROLLBACK` | opposite direction of the referenced `BET`, `WIN`, or `REFUND` |

Financial references must be processed and match the same provider, player, wallet, currency, and round. `REFUND` only accepts a `BET`; `ROLLBACK` accepts a `BET`, `WIN`, or `REFUND`; both require the same amount as the referenced transaction. `WIN` may reference a `BET` without requiring the same amount. `WagerTransaction.ledgerDirectionFor` performs these checks before determining the direction.

## Pending decisions

- Apply a pessimistic lock per wallet inside the SQL transaction.
- Define the local SQS emulator and retry and DLQ policies.

## Local persistence

PostgreSQL runs through Docker Compose, with its port bound to `127.0.0.1`. NestJS uses MikroORM 7 with the PostgreSQL driver. The initial migration creates `wallets` with balances stored in minor units as `BIGINT`, uniqueness per player and currency, a three-uppercase-letter currency format, a non-negative balance, and a positive version. The migration can be rolled back, and the integration test validates these constraints against PostgreSQL.
