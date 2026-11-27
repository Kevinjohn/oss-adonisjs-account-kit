// The admission service: evaluates admission and gates protected application routes.
import type { AccountKit } from '../account_kit.ts'
import { requireCurrentAccountInTransaction } from '../authentication.ts'
import { transaction } from '../db.ts'
import { normalizeEmail } from '../email.ts'
import {
  E_ACCOUNT_KIT_ADMISSION_REQUIRED,
  E_ACCOUNT_KIT_INVALID_SESSION,
  E_ACCOUNT_KIT_UNVERIFIED_EMAIL,
} from '../errors.ts'
import type {
  AccountUser,
  OperatorInviteResult,
  CurrentAccount,
  CurrentAccountInput,
  Trx,
  UserId,
} from '../types.ts'
import { evaluateAdmission } from './decision.ts'
import { isDomainAllowed, extractEmailDomain } from './domain.ts'
import { readAdmissionRow, toAdmissionRecord } from './rows.ts'
import type {
  AdmissionApprovalStatus,
  AdmissionContext,
  AdmissionDecision,
  AdmissionDependencies,
  AdmissionPage,
  AdmissionRecord,
} from './types.ts'
import { requestAdmission } from './request.ts'
import { decideAdmission } from './decisions.ts'
import { paginateAdmissions } from './listing.ts'
import { applyOperatorDecision, grantOperatorInvitation } from './operator.ts'
import { cancelBootstrap, bootstrapOperatorInvitation } from './bootstrap.ts'

export type { AdmissionContext, AdmissionDependencies } from './types.ts'

/**
 * Admission: whether a verified account may use the application. Resolve it with
 * `app.container.make(AccountAdmission)`. The decision is read from the database on every call.
 *
 * @example
 * ```ts
 * import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'
 * import app from '@adonisjs/core/services/app'
 *
 * const admission = await app.container.make(AccountAdmission)
 * const record = await admission.record(userId)
 * ```
 */
export class AccountAdmission {
  /** The account service this module works with. */
  readonly kit: AccountKit
  readonly #deps: AdmissionContext

  constructor(deps: AdmissionDependencies) {
    const { kit, ...rest } = deps
    this.kit = kit
    this.#deps = rest
  }

  /**
   * Evaluates the enabled requirements for `user`. The caller holds the user lock in `trx`.
   *
   * @example
   * ```ts
   * const decision = await admission.decide(user, trx)
   * ```
   */
  async decide(user: AccountUser, trx: Trx): Promise<AdmissionDecision> {
    return evaluateAdmission(this.#deps.config, user, await readAdmissionRow(trx, user.id))
  }

  /**
   * Checks the credential like `kit.authentication.current`, then evaluates admission, in one
   * transaction. Use it for the status read the limited surface shows.
   *
   * @example
   * ```ts
   * const { account, decision } = await admission.current(current)
   * ```
   *
   * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
   */
  current(
    input: CurrentAccountInput
  ): Promise<{ account: CurrentAccount; decision: AdmissionDecision }> {
    return transaction(this.#deps.db, async (trx) => {
      const account = await requireCurrentAccountInTransaction(
        { config: this.#deps.accountConfig },
        input,
        trx
      )
      const user = await this.#deps.accountConfig.users.findById(input.userId, trx)
      if (!user) throw new E_ACCOUNT_KIT_INVALID_SESSION()
      return { account, decision: await this.decide(user, trx) }
    })
  }

  /**
   * The gate for protected routes. Like `current`, then throws `E_ACCOUNT_KIT_UNVERIFIED_EMAIL` for an
   * unconfirmed account (unless `active: false`) and `E_ACCOUNT_KIT_ADMISSION_REQUIRED` unless admitted.
   *
   * @example
   * ```ts
   * const { account } = await admission.require(current)
   * ```
   *
   * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
   */
  async require(
    input: CurrentAccountInput,
    options: { active?: boolean } = {}
  ): Promise<{ account: CurrentAccount; decision: AdmissionDecision }> {
    const result = await this.current(input)
    if (options.active !== false && !result.account.active)
      throw new E_ACCOUNT_KIT_UNVERIFIED_EMAIL()
    if (!result.decision.admitted) throw new E_ACCOUNT_KIT_ADMISSION_REQUIRED(result.decision)
    return result
  }

  /**
   * Whether the user is admitted; false for an unknown user. For `authorize` and
   * `exportAccountData` callbacks: pass their `trx` when they have one.
   *
   * @example
   * ```ts
   * const admitted = await admission.isAdmitted(userId, trx)
   * ```
   */
  async isAdmitted(userId: UserId, trx?: Trx): Promise<boolean> {
    const user = await this.#deps.accountConfig.users.findById(userId, trx)
    if (!user) return false
    const row = await readAdmissionRow(trx ?? this.#deps.db.connection(), user.id)
    return evaluateAdmission(this.#deps.config, user, row).admitted
  }

  /**
   * The user's admission record, or null for an unknown user or one with no admission row. Pass the
   * caller's `trx` to see its uncommitted writes. Ids reach the users adapter as given, as in
   * `isAdmitted`.
   *
   * @example
   * ```ts
   * const record = await admission.record(userId)
   * ```
   */
  async record(userId: UserId, trx?: Trx): Promise<AdmissionRecord | null> {
    const user = await this.#deps.accountConfig.users.findById(userId, trx)
    if (!user) return null
    const row = await readAdmissionRow(trx ?? this.#deps.db.connection(), user.id)
    return row ? toAdmissionRecord(row, user.email) : null
  }

  /**
   * Whether `email` would meet the domain requirement once confirmed. True when the requirement is
   * off; false, never throwing, for a malformed address.
   *
   * @example
   * ```ts
   * const eligible = admission.eligibleDomain('sam@example.test')
   * ```
   */
  eligibleDomain(email: string): boolean {
    const rule = this.#deps.config.domain
    if (!rule) return true
    if (typeof email !== 'string') return false
    const domain = extractEmailDomain(normalizeEmail(email))
    return domain !== null && isDomainAllowed(domain, rule)
  }

  /**
   * Records that the signed-in person asked for approval, so `list({ status: 'pending' })` shows
   * them. Idempotent; emits `admission.requested` once. Refuses an unconfirmed account.
   *
   * @example
   * ```ts
   * const record = await admission.request(current)
   * ```
   *
   * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
   */
  request(input: CurrentAccountInput): Promise<AdmissionRecord> {
    return requestAdmission(this.#deps, input)
  }

  /**
   * Approves `userId`. The actor must be admitted, not the subject, and allowed by `decide`.
   *
   * @example
   * ```ts
   * await admission.approve({ actorId, userId })
   * ```
   *
   * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
   */
  approve(input: { actorId: UserId; userId: UserId }): Promise<AdmissionRecord> {
    return decideAdmission(this.#deps, input, 'approve')
  }

  /**
   * Rejects `userId`, who has no decision yet. Same actor rules as `approve`.
   *
   * @example
   * ```ts
   * await admission.reject({ actorId, userId })
   * ```
   *
   * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
   */
  reject(input: { actorId: UserId; userId: UserId }): Promise<AdmissionRecord> {
    return decideAdmission(this.#deps, input, 'reject')
  }

  /**
   * Revokes an approved `userId`. Sessions stay; the next gated request is refused.
   *
   * @example
   * ```ts
   * await admission.revoke({ actorId, userId })
   * ```
   *
   * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
   */
  revoke(input: { actorId: UserId; userId: UserId }): Promise<AdmissionRecord> {
    return decideAdmission(this.#deps, input, 'revoke')
  }

  /**
   * Admission records a page at a time, after `authorize.list` allows the actor.
   *
   * @example
   * ```ts
   * const page = await admission.list({ actorId, status: 'pending', limit: 20 })
   * ```
   */
  list(input: {
    actorId: UserId
    status?: AdmissionApprovalStatus
    cursor?: string
    limit?: number
  }): Promise<AdmissionPage> {
    return paginateAdmissions(this.#deps, input)
  }

  /**
   * Operator context only: callers with shell access (Ace commands). No actor, no `authorize`;
   * never expose these methods to an HTTP request.
   */
  get operator() {
    return {
      /**
       * Approve a person from the operator console.
       *
       * @example
       * ```ts
       * await admission.operator.approve({ email: 'sam@example.test' })
       * ```
       * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
       */
      approve: (input: { email: string }): Promise<AdmissionRecord> =>
        applyOperatorDecision(this.#deps, input, 'approve'),
      /**
       * Revoke admission from the operator console.
       *
       * @example
       * ```ts
       * await admission.operator.revoke({ email: 'sam@example.test' })
       * ```
       * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
       */
      revoke: (input: { email: string }): Promise<AdmissionRecord> =>
        applyOperatorDecision(this.#deps, input, 'revoke'),
      /**
       * Record operator-provided invitation evidence.
       *
       * @example
       * ```ts
       * await admission.operator.grantInvitation({ email: 'sam@example.test' })
       * ```
       *
       * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
       */
      grantInvitation: (input: { email: string; role?: string }): Promise<AdmissionRecord> =>
        grantOperatorInvitation(this.#deps, input),
      /**
       * Issues an operator invitation and an approval waiting for the account it creates; that
       * account lands admitted once its invitation evidence is recorded.
       *
       * @example
       * ```ts
       * await admission.operator.bootstrap({ email: 'sam@example.test', role: 'admin' })
       * ```
       *
       * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
       */
      bootstrap: (input: { email: string; role: string }): Promise<OperatorInviteResult> =>
        bootstrapOperatorInvitation(this.#deps, input),
      /**
       * Deletes the waiting approval for `email`; returns whether there was one.
       *
       * @example
       * ```ts
       * await admission.operator.cancelBootstrap({ email: 'sam@example.test' })
       * ```
       */
      cancelBootstrap: (input: { email: string }): Promise<boolean> =>
        cancelBootstrap(this.#deps, input.email),
    }
  }
}
