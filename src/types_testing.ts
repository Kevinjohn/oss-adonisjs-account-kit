import type { Trx, UsersAdapter, NotificationCallbacks } from './types_foundation.ts'

/**
 * What the adapter contract suite needs to test your users adapter: the adapter, a way to run
 * transactions, and probes for stored passwords and row locks.
 */
export interface AdapterContractFixture {
  adapter: UsersAdapter
  /** Run the callback in a transaction and commit it when it returns. */
  transaction<T>(callback: (trx: Trx) => Promise<T>): Promise<T>
  /** Return the stored password value so the contract can reject plaintext persistence. */
  storedPassword(id: number | string): Promise<string | null>
  /** Check a plaintext password against the stored value, with the application's hasher. */
  verifyPassword(stored: string, password: string): Promise<boolean>
  /** Hold the package-owned user lock while an independent writer targets that physical row. */
  assertLockBlocksWriter(
    id: number | string,
    acquireLock: (trx: Trx) => Promise<unknown>
  ): Promise<void>
  /** Acquire the package-owned user lock from adapter metadata, not through the adapter. */
  acquireAccountLock(id: number | string, trx: Trx): Promise<void>
  emailPrefix?: string
  registrationData?: unknown
  /** Set when the adapter stores string ids; the contract then checks they round-trip as strings. */
  stringIds?: boolean
  /** Exercise updateRegistrationData: the data to send and a reader for the stored result. */
  registrationUpdate?: {
    /** The registration data to send. */
    data: Record<string, unknown>
    /** Read the stored registration data back for the given user id. */
    read(id: number | string): Promise<unknown>
    /** What `read` should return after the update. */
    expected: unknown
  }
}

/** The name of a notification callback, such as `passwordResetProvision`. */
export type NotificationKind = keyof NotificationCallbacks

/** One notification recorded by `captureNotifications`. */
export interface CapturedNotification {
  kind: NotificationKind
  /** The address the built-in mail notifications would send this message to. */
  to: string
  actionUrl?: string
  /** The proof token from the action URL: its `token` query value, else its last path segment. */
  token?: string
  /** The raw callback arguments, for assertions on users, invitations and contexts. */
  args: unknown[]
}
