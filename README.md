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

Este repositório está no início: contém a aplicação NestJS mínima, o objeto de valor `Money`, o agregado `Wallet`, o modelo de transação de aposta e a entrada imutável do ledger. Persistência, concorrência e mensageria serão implementadas em etapas pequenas.

## Começar

```bash
bun install
Copy-Item .env.example .env
bun run db:up
bun run start:dev
```

A aplicação inicial responde em `http://localhost:3000/`.

O PostgreSQL local usa a porta `5432`. As credenciais padrão são apenas para desenvolvimento local; ajuste o arquivo `.env` se necessário.

## Testes

```bash
bun test
bun run test:e2e
```

Os testes atuais cobrem o esqueleto, as regras de `Money`, `Wallet`, `WagerTransaction` e ledger, e o endpoint inicial. Como o módulo Nest abre a conexão com o PostgreSQL, inicie o banco com `bun run db:up` antes de rodar os testes.

As transições de estado escolhidas para `WagerTransaction` estão em [ARCHITECTURE.md](./ARCHITECTURE.md).
