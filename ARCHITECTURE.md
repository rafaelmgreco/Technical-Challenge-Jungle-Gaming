# Decisões de arquitetura

Este documento registra decisões conforme são implementadas. Decisões ainda não implementadas são marcadas como pendentes.

## WagerTransaction

Uma transação nasce em `PENDING`.

| Estado atual | Transições permitidas |
| --- | --- |
| `PENDING` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED`, `FAILED` |
| `PROCESSED` | nenhuma; terminal |
| `REJECTED` | nenhuma; terminal |
| `FAILED` | nenhuma; terminal |

`PENDING_REFERENCE` só é permitido quando há uma referência externa para resolver. Ao processar uma transação referenciada, é necessário associar o identificador interno da transação de referência.

`REFUND` e `ROLLBACK` exigem uma referência externa. `WIN` pode carregar uma referência opcional. Uma transação `LOSS` não altera o saldo. Todos os valores de transação precisam ser positivos.

Os códigos de falha são strings estáveis em formato maiúsculo legível por máquina, por exemplo `INSUFFICIENT_FUNDS`. A lista de códigos específicos do processamento financeiro será consolidada junto com os casos de uso.

## Próximas decisões

- Definir o lançamento imutável de ledger e a direção dos lançamentos de reversão.
- Definir as constraints e migrations do PostgreSQL com valores monetários em centavos `BIGINT`.
- Aplicar bloqueio pessimista por carteira dentro da transação SQL.
- Definir o emulador de SQS local e as políticas de retry e DLQ.
