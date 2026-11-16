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

The repository is in its early stages. It contains a minimal NestJS application, the `Money` value object, the `Wallet` aggregate, the wager transaction model, immutable ledger entries, PostgreSQL migrations, a MikroORM wallet and ledger repository, and transactional wallet movements with a pessimistic row lock. Messaging will be implemented in a later step.

## Getting started

```bash
bun install
Copy-Item .env.example .env
bun run db:up
bun run db:migrate
bun run start:dev
```

The application responds at `http://localhost:3000/`.

The local PostgreSQL instance uses port `5432`. The default credentials are for local development only; update `.env` if needed.

## Tests

```bash
bun test
bun run test:e2e
```

The current tests cover the application scaffold, the rules for `Money`, `Wallet`, `WagerTransaction`, and the ledger, the initial endpoint, database constraints, repository persistence, atomic rollback, and concurrent wallet movements in PostgreSQL. Start the database with `bun run db:up` before running the tests.

The selected `WagerTransaction` state transitions are documented in [ARCHITECTURE.md](./ARCHITECTURE.md).
