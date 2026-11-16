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

Este repositório está no início: contém a aplicação NestJS mínima e o objeto de valor `Money`. As regras de carteira, ledger, concorrência e mensageria serão implementadas em etapas pequenas.

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

Os testes atuais cobrem o esqueleto e as operações de `Money`. Cada regra de domínio e cada integração serão testadas quando forem adicionadas.
