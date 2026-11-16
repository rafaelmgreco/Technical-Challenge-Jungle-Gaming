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

`OPENING` representa somente o crédito interno de abertura da carteira. Os adaptadores HTTP e SQS deverão rejeitar `OPENING` como operação submetida por provedor.

Os códigos de falha são strings estáveis em formato maiúsculo legível por máquina, por exemplo `INSUFFICIENT_FUNDS`. A lista de códigos específicos do processamento financeiro será consolidada junto com os casos de uso.

## Ledger

Cada `WalletLedgerEntry` é imutável e registra carteira, transação, direção, valor, saldo anterior, saldo posterior e instante de criação. A factory `create` exige moedas iguais, valor positivo, saldos não negativos e valida `saldo anterior ± valor = saldo posterior`. A unicidade de uma entrada por carteira e transação será garantida por constraint no PostgreSQL.

| Transação | Direção |
| --- | --- |
| `OPENING` | crédito |
| `BET` | débito |
| `WIN` | crédito |
| `LOSS` | sem entrada |
| `REFUND` | crédito da `BET` referenciada |
| `ROLLBACK` | direção oposta da `BET`, `WIN` ou `REFUND` referenciada |

Referências financeiras precisam estar processadas e corresponder ao mesmo provedor, jogador, carteira, moeda e rodada. `REFUND` só aceita `BET`; `ROLLBACK` aceita `BET`, `WIN` ou `REFUND`; ambos exigem valor igual ao da referência. `WIN` pode referenciar uma `BET` sem exigir valor igual. `WagerTransaction.ledgerDirectionFor` aplica essas verificações antes de determinar a direção.

## Próximas decisões

- Mapear as entidades e criar migrations reversíveis do PostgreSQL com valores monetários em centavos `BIGINT`.
- Aplicar bloqueio pessimista por carteira dentro da transação SQL.
- Definir o emulador de SQS local e as políticas de retry e DLQ.

## Persistência local

O PostgreSQL roda em Docker Compose, com a porta local limitada a `127.0.0.1`. O NestJS usa MikroORM 7 com o driver PostgreSQL; migrations estão registradas, mas ainda não há tabelas de domínio. A tabela inicial e suas constraints serão adicionadas no próximo passo.
