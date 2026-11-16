import type { WalletRepository } from './wallet.repository.js';
import type { WalletLedgerRepository } from './wallet-ledger.repository.js';

export const WALLET_UNIT_OF_WORK = Symbol('WALLET_UNIT_OF_WORK');

export interface WalletRepositories {
  wallets: WalletRepository;
  ledger: WalletLedgerRepository;
}

export interface WalletUnitOfWork {
  execute<T>(operation: (repositories: WalletRepositories) => Promise<T>): Promise<T>;
}
