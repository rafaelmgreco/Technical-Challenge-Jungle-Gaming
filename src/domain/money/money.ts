export interface MoneyProps {
  amount: string;
  currency: string;
}

const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;
const ISO_4217_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class MoneyCurrencyMismatchError extends Error {
  constructor(left: string, right: string) {
    super(`Cannot operate on different currencies: ${left} and ${right}`);
    this.name = 'MoneyCurrencyMismatchError';
  }
}

/** Exact monetary value represented internally as integer minor units. */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  /** Builds Money from a non-negative, fixed two-decimal input string. */
  static from(props: MoneyProps): Money {
    Money.assertValidCurrency(props.currency);

    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyError('Money amount must be a decimal string');
    }

    const match = /^(\d+)\.(\d{2})$/.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(
        'Money amount must use a non-negative decimal string with exactly two decimal places',
      );
    }

    const amount = BigInt(match[1]) * 100n + BigInt(match[2]);
    return Money.fromMinorUnits(amount, props.currency);
  }

  /** Rehydrates an exact minor-unit value, including signed intermediate values. */
  static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    Money.assertValidCurrency(currency);

    if (typeof minorUnits !== 'bigint') {
      throw new InvalidMoneyError('Money minor units must be a bigint');
    }

    const absoluteValue = minorUnits < 0n ? -minorUnits : minorUnits;
    if (absoluteValue > MAX_MINOR_UNITS) {
      throw new InvalidMoneyError('Money amount exceeds the supported BIGINT range');
    }

    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return Money.fromMinorUnits(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.fromMinorUnits(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toMinorUnits(): bigint {
    return this.minorUnits;
  }

  toString(): string {
    const negative = this.minorUnits < 0n;
    const absoluteValue = negative ? -this.minorUnits : this.minorUnits;
    const wholeUnits = absoluteValue / 100n;
    const fractionalUnits = (absoluteValue % 100n).toString().padStart(2, '0');

    return `${negative ? '-' : ''}${wholeUnits}.${fractionalUnits}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyCurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: string): void {
    if (
      typeof currency !== 'string' ||
      !/^[A-Z]{3}$/.test(currency) ||
      !ISO_4217_CURRENCIES.has(currency)
    ) {
      throw new InvalidMoneyError('Currency must be a supported ISO 4217 code');
    }
  }
}
