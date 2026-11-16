import {
  Money,
  MoneyCurrencyMismatchError,
  type MoneyProps,
} from '../money/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function oppositeLedgerDirection(
  direction: LedgerDirection,
): LedgerDirection {
  return direction === LedgerDirection.Debit
    ? LedgerDirection.Credit
    : LedgerDirection.Debit;
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

/** An immutable record of one exact balance movement. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.assertIdentifiers(props);
    WalletLedgerEntry.assertDirection(props.direction);
    WalletLedgerEntry.assertValidDate(props.createdAt);
    WalletLedgerEntry.assertSameCurrency(
      props.money,
      props.balanceBefore,
      props.balanceAfter,
    );

    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger amount must be positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger balances cannot be negative');
    }

    const expectedBalanceAfter = WalletLedgerEntry.calculateBalanceAfter(
      props.direction,
      props.money,
      props.balanceBefore,
    );

    if (!expectedBalanceAfter.equals(props.balanceAfter)) {
      throw new InvalidLedgerEntryError(
        'Ledger entry does not balance: before ± amount must equal after',
      );
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt.getTime()),
    );
  }

  /** Rebuilds a persisted entry; reconciliation can check it with isBalanced(). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    WalletLedgerEntry.assertIdentifiers(state);
    WalletLedgerEntry.assertDirection(state.direction);
    WalletLedgerEntry.assertValidDate(state.createdAt);

    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.money),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      new Date(state.createdAt.getTime()),
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  isBalanced(): boolean {
    try {
      WalletLedgerEntry.assertSameCurrency(
        this.money,
        this.balanceBefore,
        this.balanceAfter,
      );
      if (
        this.money.isNegative() ||
        this.balanceBefore.isNegative() ||
        this.balanceAfter.isNegative()
      ) {
        return false;
      }

      return WalletLedgerEntry.calculateBalanceAfter(
        this.direction,
        this.money,
        this.balanceBefore,
      ).equals(this.balanceAfter);
    } catch {
      return false;
    }
  }

  private static calculateBalanceAfter(
    direction: LedgerDirection,
    money: Money,
    balanceBefore: Money,
  ): Money {
    return direction === LedgerDirection.Debit
      ? balanceBefore.subtract(money)
      : balanceBefore.add(money);
  }

  private static assertSameCurrency(...values: Money[]): void {
    const [first, ...rest] = values;
    if (!first) {
      return;
    }

    for (const money of rest) {
      if (money.currency !== first.currency) {
        throw new MoneyCurrencyMismatchError(first.currency, money.currency);
      }
    }
  }

  private static assertIdentifiers(
    value: Pick<LedgerEntryState, 'id' | 'walletId' | 'transactionId'>,
  ): void {
    for (const [field, identifier] of [
      ['id', value.id],
      ['walletId', value.walletId],
      ['transactionId', value.transactionId],
    ] as const) {
      if (typeof identifier !== 'string' || identifier.trim().length === 0) {
        throw new InvalidLedgerEntryError(`${field} cannot be empty`);
      }
    }
  }

  private static assertDirection(direction: LedgerDirection): void {
    if (!Object.values(LedgerDirection).includes(direction)) {
      throw new InvalidLedgerEntryError('Unknown ledger direction');
    }
  }

  private static assertValidDate(value: Date): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidLedgerEntryError('createdAt must be a valid date');
    }
  }
}
