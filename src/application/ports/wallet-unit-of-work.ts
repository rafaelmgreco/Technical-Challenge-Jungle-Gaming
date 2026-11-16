import type { WalletRepository } from './wallet.repository.js';

export const WALLET_UNIT_OF_WORK = Symbol('WALLET_UNIT_OF_WORK');

export interface WalletUnitOfWork {
  execute<T>(operation: (wallets: WalletRepository) => Promise<T>): Promise<T>;
}
