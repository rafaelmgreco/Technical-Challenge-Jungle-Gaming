import { Money, MoneyCurrencyMismatchError, type MoneyProps } from '../money/money.js';

export type WalletMovementDirection = 'DEBIT' | 'CREDIT';

export interface WalletBalanceChange {
  direction: WalletMovementDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  occurredAt: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class InvalidWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletError';
  }
}

export class InsufficientWalletFundsError extends Error {
  constructor(public readonly failureCode = 'INSUFFICIENT_FUNDS') {
    super('Wallet balance is insufficient for this debit');
    this.name = 'InsufficientWalletFundsError';
  }
}

export class InvalidWalletMovementError extends Error {
  constructor() {
    super('Wallet movements must be positive amounts');
    this.name = 'InvalidWalletMovementError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openedAt?: Date;
  }): Wallet {
    Wallet.assertIdentifier(props.id, 'id');
    Wallet.assertIdentifier(props.playerId, 'playerId');

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('Initial balance cannot be negative');
    }

    const openedAt = props.openedAt ?? new Date();
    Wallet.assertValidDate(openedAt, 'openedAt');

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(openedAt.getTime()),
      new Date(openedAt.getTime()),
    );
  }

  /** Reconstructs state already persisted without replaying domain transitions. */
  static rehydrate(state: WalletState): Wallet {
    Wallet.assertIdentifier(state.id, 'id');
    Wallet.assertIdentifier(state.playerId, 'playerId');

    if (!Number.isSafeInteger(state.version) || state.version < 1) {
      throw new InvalidWalletError('Wallet version must be a positive safe integer');
    }

    Wallet.assertValidDate(state.createdAt, 'createdAt');
    Wallet.assertValidDate(state.updatedAt, 'updatedAt');

    const balance = Money.from(state.balance);

    return new Wallet(
      state.id,
      state.playerId,
      balance.currency,
      balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  debit(money: Money, at: Date = new Date()): WalletBalanceChange {
    return this.applyMovement('DEBIT', money, at);
  }

  credit(money: Money, at: Date = new Date()): WalletBalanceChange {
    return this.applyMovement('CREDIT', money, at);
  }

  private applyMovement(
    direction: WalletMovementDirection,
    money: Money,
    at: Date,
  ): WalletBalanceChange {
    this.assertSameCurrency(money);
    Wallet.assertValidDate(at, 'movement date');

    if (!money.isPositive()) {
      throw new InvalidWalletMovementError();
    }

    const balanceBefore = this._balance;
    const balanceAfter =
      direction === 'DEBIT'
        ? balanceBefore.subtract(money)
        : balanceBefore.add(money);

    if (balanceAfter.isNegative()) {
      throw new InsufficientWalletFundsError();
    }

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(at.getTime());

    return {
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version,
      occurredAt: new Date(at.getTime()),
    };
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new MoneyCurrencyMismatchError(this.currency, money.currency);
    }
  }

  private static assertIdentifier(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidWalletError(`${field} cannot be empty`);
    }
  }

  private static assertValidDate(value: Date, field: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidWalletError(`${field} must be a valid date`);
    }
  }
}
