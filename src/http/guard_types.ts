import type { UserId } from '../types_foundation.ts'

/** The user fields the managed guard reads. */
export interface ManagedUser {
  id: UserId
  currentAccessToken?: { identifier: UserId | BigInt }
}

/** A user model the managed guard can load users from. */
export interface ManagedUserModel<User> {
  /** Load a user by id; throws when there is none. */
  findOrFail(id: UserId): Promise<User>
}

/** A user model with an AdonisJS access-token provider, for a token guard. */
export interface ManagedTokenModel<User> extends ManagedUserModel<User> {
  accessTokens: {
    /** Issue a token; `value.release()` returns the plaintext token once. */
    create(
      user: User,
      abilities: string[],
      options?: { expiresIn?: string | number; name?: string }
    ): Promise<{
      identifier: UserId | BigInt
      /** Set when a token was just created; `release` returns its plaintext once. */
      value?: {
        /** The plaintext token; AdonisJS lets it be read once. */
        release(): string
      } | null
    }>
    /** Revoke one of the user's tokens by its identifier. */
    delete(user: User, identifier: UserId | BigInt): Promise<unknown>
  }
}

/**
 * An access token issued by the managed token guard. `value` is the bearer secret, present only
 * right after issuance.
 */
export interface ManagedTokenCredential {
  /** The user the token belongs to. */
  userId: UserId
  /** The token row id. */
  identifier: UserId
  /** The bearer secret. Present only right after issuance; return it once and never log it. */
  value?: string
}

/** Options for `createManagedGuard` with an existing session guard. */
export type ManagedSessionGuardOptions<User> = {
  /** Always `session`. */
  strategy: 'session'
  /** The existing session guard's name in `config/auth.ts`. */
  name: string
  /** Loads the user model lazily. */
  loadUser(): Promise<ManagedUserModel<User>>
}

/** Options for `createManagedGuard` with an existing access-token guard. */
export type ManagedTokenGuardOptions<User> = {
  /** Always `access_tokens`. */
  strategy: 'access_tokens'
  /** The existing access-token guard's name in `config/auth.ts`. */
  name: string
  /** Loads the user model, which must have an `accessTokens` provider. */
  loadUser(): Promise<ManagedTokenModel<User>>
}
