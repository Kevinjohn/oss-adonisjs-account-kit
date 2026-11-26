import type { Database } from '@adonisjs/lucid/database'
import { transaction } from './transaction.ts'
import { lockRow } from './user_lock.ts'
import type { Trx, UserId } from './types.ts'

/**
 * Runs account-related SQL writes with Account Kit's locking and commit semantics.
 *
 * @example
 * ```ts
 * import { TransactionManager } from '@kevinjohn/adonisjs-account-kit/transaction'
 * import db from '@adonisjs/lucid/services/db'
 *
 * const transactions = new TransactionManager(db)
 * ```
 */
export class TransactionManager {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  /**
   * Run database work in a package transaction. Send notifications after it resolves.
   *
   * @throws {AggregateError} When transaction work and cleanup both fail, or multiple cleanup steps fail.
   *
   * @example
   * ```ts
   * await transactions.run(async (trx) => {
   *   await trx.from('users').where('id', userId).update({ display_name: 'Sam Example' })
   * })
   * ```
   */
  run<T>(callback: (trx: Trx) => Promise<T>): Promise<T> {
    return transaction(this.#db, callback)
  }

  /**
   * Lock a physical row on PostgreSQL or MySQL. SQLite already holds its writer lock.
   *
   * @example
   * ```ts
   * await transactions.run(async (trx) => {
   *   await transactions.lockRow(trx, 'users', userId)
   * })
   * ```
   */
  lockRow(trx: Trx, table: string, id: UserId): Promise<void> {
    return lockRow(trx, table, id)
  }
}
