import type { WalletLedgerEntry } from '../../domain/ledger/ledger-entry.js';

export interface WalletLedgerCursor {
  createdAt: Date;
  id: string;
}

export interface WalletLedgerRepository {
  findByWalletAndTransactionId(walletId: string, transactionId: string): Promise<WalletLedgerEntry | null>;
  findByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
  findByWalletPage(
    walletId: string,
    after: WalletLedgerCursor | undefined,
    limit: number,
  ): Promise<WalletLedgerEntry[]>;
  save(entry: WalletLedgerEntry): Promise<void>;
}
