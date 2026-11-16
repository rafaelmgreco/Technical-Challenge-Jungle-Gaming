import { Money, type MoneyProps } from '../money/money.js';
import {
  LedgerDirection,
  oppositeLedgerDirection,
} from '../ledger/ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** A stable, uppercase machine-readable code explaining a terminal failure. */
export type FailureCode = string;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  processedBalance?: MoneyProps;
  referenceAttemptCount?: number;
  referenceNextAttemptAt?: Date;
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidWagerTransactionStateError extends Error {
  constructor(status: WagerTransactionStatus) {
    super(`Cannot transition a ${status} wager transaction`);
    this.name = 'InvalidWagerTransactionStateError';
  }
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _processedBalance?: Money,
    private _referenceAttemptCount = 0,
    private _referenceNextAttemptAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertIdentifiers(props);
    WagerTransaction.assertKind(props.kind);
    WagerTransaction.assertValidDate(props.createdAt, 'createdAt');

    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        'Wager transaction amount must be positive',
      );
    }

    const referenceExternalTransactionId =
      props.referenceExternalTransactionId;
    if (
      referenceExternalTransactionId !== undefined &&
      referenceExternalTransactionId.trim().length === 0
    ) {
      throw new InvalidWagerTransactionError(
        'Reference external transaction id cannot be empty',
      );
    }

    if (
      WagerTransaction.requiresReferenceKind(props.kind) &&
      referenceExternalTransactionId === undefined
    ) {
      throw new InvalidWagerTransactionError(
        `${props.kind} requires a reference external transaction id`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      referenceExternalTransactionId,
      new Date(props.createdAt.getTime()),
      WagerTransactionStatus.Pending,
    );
  }

  /** Rebuilds persisted state without re-running transaction transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    WagerTransaction.assertIdentifiers(state);
    WagerTransaction.assertKind(state.kind);
    WagerTransaction.assertStatus(state.status);
    WagerTransaction.assertValidDate(state.createdAt, 'createdAt');

    if (
      state.referenceExternalTransactionId !== undefined &&
      state.referenceExternalTransactionId.trim().length === 0
    ) {
      throw new InvalidWagerTransactionError(
        'Reference external transaction id cannot be empty',
      );
    }

    if (state.failureCode !== undefined) {
      WagerTransaction.assertFailureCode(state.failureCode);
    }
    if (state.processedAt !== undefined) {
      WagerTransaction.assertValidDate(state.processedAt, 'processedAt');
    }
    const processedBalance = state.processedBalance
      ? Money.from(state.processedBalance)
      : undefined;
    if (processedBalance && processedBalance.currency !== state.money.currency) {
      throw new InvalidWagerTransactionError('Processed balance currency must match transaction currency');
    }
    if (processedBalance && processedBalance.isNegative()) {
      throw new InvalidWagerTransactionError('Processed balance cannot be negative');
    }
    const referenceAttemptCount = state.referenceAttemptCount ?? 0;
    if (!Number.isSafeInteger(referenceAttemptCount) || referenceAttemptCount < 0) {
      throw new InvalidWagerTransactionError('Reference attempt count must be a non-negative safe integer');
    }
    if (state.referenceNextAttemptAt !== undefined) {
      WagerTransaction.assertValidDate(state.referenceNextAttemptAt, 'referenceNextAttemptAt');
    }

    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      new Date(state.createdAt.getTime()),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
      processedBalance,
      referenceAttemptCount,
      state.referenceNextAttemptAt ? new Date(state.referenceNextAttemptAt.getTime()) : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  get processedBalance(): Money | undefined {
    return this._processedBalance;
  }

  get referenceAttemptCount(): number {
    return this._referenceAttemptCount;
  }

  get referenceNextAttemptAt(): Date | undefined {
    return this._referenceNextAttemptAt ? new Date(this._referenceNextAttemptAt.getTime()) : undefined;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, balance?: Money): void {
    this.assertCanTransition();
    WagerTransaction.assertValidDate(at, 'processedAt');
    if (balance && balance.currency !== this.money.currency) {
      throw new InvalidWagerTransactionError('Processed balance currency must match transaction currency');
    }
    if (balance && balance.isNegative()) {
      throw new InvalidWagerTransactionError('Processed balance cannot be negative');
    }

    if (
      (this.referenceExternalTransactionId !== undefined ||
        this.requiresReference()) &&
      !WagerTransaction.isNonEmptyString(referenceTransactionId)
    ) {
      throw new InvalidWagerTransactionError(
        'A resolved internal reference transaction id is required',
      );
    }

    if (
      this.referenceExternalTransactionId === undefined &&
      referenceTransactionId !== undefined
    ) {
      throw new InvalidWagerTransactionError(
        'An internal reference id cannot be set without an external reference',
      );
    }

    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = new Date(at.getTime());
    this._processedBalance = balance;
    this._referenceNextAttemptAt = undefined;
    this._status = WagerTransactionStatus.Processed;
  }

  markPendingReference(nextAttemptAt: Date): void {
    if (
      this._status !== WagerTransactionStatus.Pending ||
      this.referenceExternalTransactionId === undefined
    ) {
      throw new InvalidWagerTransactionStateError(this._status);
    }
    WagerTransaction.assertValidDate(nextAttemptAt, 'referenceNextAttemptAt');

    this._referenceAttemptCount = 1;
    this._referenceNextAttemptAt = new Date(nextAttemptAt.getTime());
    this._status = WagerTransactionStatus.PendingReference;
  }

  recordReferenceRetry(nextAttemptAt: Date): number {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidWagerTransactionStateError(this._status);
    }
    WagerTransaction.assertValidDate(nextAttemptAt, 'referenceNextAttemptAt');
    this._referenceAttemptCount += 1;
    this._referenceNextAttemptAt = new Date(nextAttemptAt.getTime());
    return this._referenceAttemptCount;
  }

  reject(code: FailureCode): void {
    this.assertCanTransition();
    WagerTransaction.assertFailureCode(code);
    this._failureCode = code;
    this._referenceNextAttemptAt = undefined;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertCanTransition();
    WagerTransaction.assertFailureCode(code);
    this._failureCode = code;
    this._referenceNextAttemptAt = undefined;
    this._status = WagerTransactionStatus.Failed;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return WagerTransaction.requiresReferenceKind(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Win:
        if (this.referenceExternalTransactionId !== undefined) {
          this.assertReference(reference, [WagerTransactionKind.Bet], false);
        }
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Refund:
        this.assertReference(reference, [WagerTransactionKind.Bet]);
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        this.assertReference(reference, [
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
        ]);

        const referenceDirection =
          reference.kind === WagerTransactionKind.Bet
            ? LedgerDirection.Debit
            : LedgerDirection.Credit;
        return oppositeLedgerDirection(referenceDirection);
      }
    }
  }

  private assertCanTransition(): void {
    if (this.isTerminal()) {
      throw new InvalidWagerTransactionStateError(this._status);
    }
  }

  private assertReference(
    reference: WagerTransaction | undefined,
    allowedKinds: readonly WagerTransactionKind[],
    requireSameAmount = true,
  ): asserts reference is WagerTransaction {
    if (!reference) {
      throw new InvalidWagerTransactionError(
        `${this.kind} requires its resolved reference transaction`,
      );
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new InvalidWagerTransactionError(
        'Reference transaction must be processed',
      );
    }
    if (!allowedKinds.includes(reference.kind)) {
      throw new InvalidWagerTransactionError(
        `${this.kind} cannot reference a ${reference.kind} transaction`,
      );
    }
    if (
      reference.externalTransactionId !==
        this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      throw new InvalidWagerTransactionError(
        'Reference transaction must match provider, player, wallet, currency, and round',
      );
    }
    if (requireSameAmount && !reference.money.equals(this.money)) {
      throw new InvalidWagerTransactionError(
        'Reference transaction amount must match',
      );
    }
  }

  private static requiresReferenceKind(kind: WagerTransactionKind): boolean {
    return (
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback
    );
  }

  private static assertIdentifiers(
    props: Pick<
      WagerTransactionState,
      | 'id'
      | 'providerId'
      | 'externalTransactionId'
      | 'idempotencyKey'
      | 'payloadHash'
      | 'walletId'
      | 'playerId'
      | 'roundId'
      | 'gameId'
    >,
  ): void {
    const fields = [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const;

    for (const field of fields) {
      if (!WagerTransaction.isNonEmptyString(props[field])) {
        throw new InvalidWagerTransactionError(`${field} cannot be empty`);
      }
    }
  }

  private static assertKind(kind: WagerTransactionKind): void {
    if (!Object.values(WagerTransactionKind).includes(kind)) {
      throw new InvalidWagerTransactionError('Unknown wager transaction kind');
    }
  }

  private static assertStatus(status: WagerTransactionStatus): void {
    if (!Object.values(WagerTransactionStatus).includes(status)) {
      throw new InvalidWagerTransactionError(
        'Unknown wager transaction status',
      );
    }
  }

  private static assertFailureCode(code: FailureCode): void {
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(code)) {
      throw new InvalidWagerTransactionError(
        'Failure code must be a stable uppercase machine-readable code',
      );
    }
  }

  private static assertValidDate(value: Date, field: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidWagerTransactionError(`${field} must be a valid date`);
    }
  }

  private static isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }
}
