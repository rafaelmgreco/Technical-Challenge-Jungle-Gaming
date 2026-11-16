# Distributed Wagering Processor

Projeto para o [desafio técnico de backend da Jungle Gaming](https://github.com/junglegaming/backend-challenge).

## Stack

- Bun 1.x como runtime, gerenciador de pacotes e executor de testes
- TypeScript em modo estrito
- NestJS
- PostgreSQL
- AWS SQS via LocalStack ou MiniStack
- Docker Compose
- MikroORM

## Estado atual

Este repositório está no início: contém a aplicação NestJS mínima, o objeto de valor `Money`, o agregado `Wallet` e o modelo de transação de aposta. Ledger, persistência, concorrência e mensageria serão implementados em etapas pequenas.

## Começar

```bash
bun install
bun run start:dev
```

A aplicação inicial responde em `http://localhost:3000/`.

## Testes

```bash
bun test
bun run test:e2e
```

Os testes atuais cobrem o esqueleto e as regras de `Money`, `Wallet` e `WagerTransaction`. Cada regra de domínio e cada integração serão testadas quando forem adicionadas.

As transições de estado escolhidas para `WagerTransaction` estão em [ARCHITECTURE.md](./ARCHITECTURE.md).
