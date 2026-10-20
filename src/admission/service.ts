// The admission service: evaluates admission and gates protected application routes.
import type { Database } from '@adonisjs/lucid/database'
import type { AccountKit } from '../account_kit.js'
import { currentInTransaction } from '../authentication.js'
import { transaction } from '../db.js'
import { normalizeEmail } from '../email.js'
import { InvalidSessionError, UnverifiedEmailError } from '../errors.js'
import type {
  AccountUser,
  CurrentAccount,
  CurrentAccountInput,
  ResolvedConfig,
  Trx,
  UserId,
} from '../types.js'
import { evaluateAdmission } from './decision.js'
import { domainAllowed, domainOf } from './domain.js'
import { AdmissionRequiredError } from './errors.js'
import { readAdmissionRow } from './rows.js'
import type { AdmissionDecision, ResolvedAdmissionConfig } from './types.js'

/** The dependencies the admission service is built from; the provider supplies them. */
export interface AdmissionDependencies {
  kit: AccountKit
  db: Database
  /** The resolved `config/account_kit.ts`. */
  accountConfig: ResolvedConfig
  /** The resolved `config/admission.ts`. */
  config: ResolvedAdmissionConfig
}

/**
 * Admission: whether a verified account may use the application. Resolve it with
 * `app.container.make(AccountAdmission)`. The decision is read from the database on every call.
 */
export class AccountAdmission {
  /** The account service this module works with. */
  readonly kit: AccountKit
  protected readonly deps: Omit<AdmissionDependencies, 'kit'>

  constructor(deps: AdmissionDependencies) {
    const { kit, ...rest } = deps
    this.kit = kit
    this.deps = rest
  }

  /** Evaluates the enabled requirements for `user`. The caller holds the user lock in `trx`. */
  async decide(user: AccountUser, trx: Trx): Promise<AdmissionDecision> {
    return evaluateAdmission(this.deps.config, user, await readAdmissionRow(trx, user.id))
  }

  /**
   * Checks the credential like `kit.authentication.current`, then evaluates admission, in one
   * transaction. Use it for the status read the limited surface shows.
   */
  current(
    input: CurrentAccountInput
  ): Promise<{ account: CurrentAccount; decision: AdmissionDecision }> {
    return transaction(this.deps.db, async (trx) => {
      const account = await currentInTransaction({ config: this.deps.accountConfig }, input, trx)
      const user = await this.deps.accountConfig.users.findById(input.userId, trx)
      if (!user) throw new InvalidSessionError()
      return { account, decision: await this.decide(user, trx) }
    })
  }

  /**
   * The gate for protected routes. Like `current`, then throws `UnverifiedEmailError` for an
   * unconfirmed account (unless `active: false`) and `AdmissionRequiredError` unless admitted.
   */
  async require(
    input: CurrentAccountInput,
    options: { active?: boolean } = {}
  ): Promise<{ account: CurrentAccount; decision: AdmissionDecision }> {
    const result = await this.current(input)
    if (options.active !== false && !result.account.active) throw new UnverifiedEmailError()
    if (!result.decision.admitted) throw new AdmissionRequiredError(result.decision)
    return result
  }

  /**
   * Whether the user is admitted; false for an unknown user. For `authorize` and
   * `exportAccountData` callbacks: pass their `trx` when they have one.
   */
  async isAdmitted(userId: UserId, trx?: Trx): Promise<boolean> {
    const user = await this.deps.accountConfig.users.findById(userId, trx)
    if (!user) return false
    const row = await readAdmissionRow(trx ?? this.deps.db.connection(), user.id)
    return evaluateAdmission(this.deps.config, user, row).admitted
  }

  /**
   * Whether `email` would meet the domain requirement once confirmed. True when the requirement is
   * off; false, never throwing, for a malformed address.
   */
  eligibleDomain(email: string): boolean {
    const rule = this.deps.config.domain
    if (!rule) return true
    if (typeof email !== 'string') return false
    const domain = domainOf(normalizeEmail(email))
    return domain !== null && domainAllowed(domain, rule)
  }
}
