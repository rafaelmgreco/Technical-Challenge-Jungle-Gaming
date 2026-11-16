import type { WalletRepository } from './wallet.repository.js';
import type { WalletLedgerRepository } from './wallet-ledger.repository.js';
import type { WagerTransactionRepository } from './wager-transaction.repository.js';
import type { IntegrationEventOutboxRepository } from './integration-event-outbox.repository.js';
import type { InboxMessageRepository } from './inbox-message.repository.js';

export const WALLET_UNIT_OF_WORK = Symbol('WALLET_UNIT_OF_WORK');

export interface WalletRepositories {
  wallets: WalletRepository;
  ledger: WalletLedgerRepository;
  transactions: WagerTransactionRepository;
  outbox: IntegrationEventOutboxRepository;
  inbox: InboxMessageRepository;
}

export interface WalletUnitOfWork {
  execute<T>(
    operation: (repositories: WalletRepositories) => Promise<T>,
  ): Promise<T>;
}
