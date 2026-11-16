import type { WalletLedgerEntry } from '../../domain/ledger/ledger-entry.js';

export interface WalletLedgerRepository {
  findByWalletAndTransactionId(walletId: string, transactionId: string): Promise<WalletLedgerEntry | null>;
  findByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
  save(entry: WalletLedgerEntry): Promise<void>;
}
