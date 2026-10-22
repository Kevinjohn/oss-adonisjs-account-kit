import type { socialProviderNames } from './social_providers.js'
import type { sensitivePurposes, socialIntents } from './social_enums.js'
import type { AccountUser, UserId, CurrentAccountInput } from './types.js'

/** A supported social provider: `google` or `github`. */
export type SocialProviderName = (typeof socialProviderNames)[number]

/** What a social flow is for: `login`, `link`, `reauth`, or `confirm` to finish a pending link. */
export type SocialIntent = (typeof socialIntents)[number]

/** The action a recent-authentication proof allows. A proof works once, for its purpose only. */
export type SensitivePurpose = (typeof sensitivePurposes)[number]

/** Returned only after the configured adapter verifies provider authentication evidence. */
export interface VerifiedSocialAuthentication {
  verified: true
  subject: string
  /** Provider-attested authentication time as an ISO 8601 UTC timestamp. */
  authenticatedAt: string
}

/** The application uses Ally at this boundary. Provider credentials never reach Account Kit. */
export interface SocialProvider {
  /** Returns the provider's authorization URL carrying Account Kit's `state`. */
  authorizationUrl(state: string, context?: unknown): Promise<string>
  /** Reads the provider profile from the callback request. Provider tokens must not be returned. */
  resolve(callback: unknown): Promise<{
    subject: string
    email: string | null
    emailVerified: boolean
    name?: string | null
    nickname?: string | null
    avatarUrl?: string | null
  }>
  /** Omit when this provider cannot attest a fresh authentication event. */
  verifyFreshAuthentication?(
    callback: unknown,
    expected: { state: string; subject: string }
  ): Promise<VerifiedSocialAuthentication | null>
}

/** Configuration for `socialAuthentication`: one adapter per enabled provider. */
export interface SocialAuthenticationConfig {
  /** One adapter per enabled provider, usually from `createAllySocialProvider`. */
  providers: Partial<Record<SocialProviderName, SocialProvider>>
  /**
   * Refuses a provider account before it is linked to a signed-in account: throw
   * `SocialLinkRefusedError` to refuse. Runs inside the link transaction, under the user lock,
   * with the locked user. Decide from the arguments only: no database reads or writes and no
   * remote side effects. It may run more than once for one callback.
   */
  acceptLink?(user: AccountUser, profile: SocialLinkProfile): Promise<void>
}

/** The provider account a signed-in user is about to link, passed to `acceptLink`. */
export interface SocialLinkProfile {
  provider: SocialProviderName
  /** The provider's stable, case-sensitive subject. */
  subject: string
  email: string | null
  emailVerified: boolean
}

/** A provider account linked to a local user. `providerUserId` is the provider's stable subject. */
export interface SocialIdentity {
  id: number
  userId: UserId
  provider: SocialProviderName
  /** The provider's stable, case-sensitive subject. */
  providerUserId: string
  /** The email the provider reported. Never used to merge accounts. */
  email: string | null
  /** Whether the provider said the email is verified. */
  emailVerified: boolean
}

/** Input for `socialAuthentication.begin`. */
export interface SocialBeginInput {
  /** The provider to start with. */
  provider: SocialProviderName
  /** `login`, `link` or `reauth`. */
  intent: Exclude<SocialIntent, 'confirm'>
  /** The signed-in credential. Required for `link` and `reauth`. */
  current?: CurrentAccountInput
  /** The action a `reauth` proof is for. */
  purpose?: SensitivePurpose
  /** SHA-256 base64url challenge of a verifier held by the initiating client. */
  clientChallenge: string
  /** Opaque request context for a request-scoped provider adapter. */
  context?: unknown
  /** Recent social_link proof kept in the server transaction, never in the provider URL. */
  proof?: string
}

/** Input for `socialAuthentication.callback`, with the request-scoped provider callback. */
export interface SocialCallbackInput {
  /** The one-use state from the callback query. */
  state: string
  /** The route provider, when the caller has a provider-specific callback URL. */
  provider?: SocialProviderName
  /** The request-scoped value your provider adapter's `resolve` reads, such as the Ally context. */
  callback: unknown
  intent?: SocialIntent
  /** The signed-in credential, for `link` and `reauth`. */
  current?: CurrentAccountInput
  /** A fresh proof supplied directly to a link callback. */
  proof?: string
  /** The email proof that confirms a pending identity. */
  verificationToken?: string
}

/**
 * The outcome of a provider callback: signed in (`linked`), needs more data or verification
 * (`new`), needs linking from a signed-in account (`link_required`), or a fresh proof
 * (`reauthenticated`).
 */
export type SocialCallbackResult =
  | { status: 'linked' | 'new'; userId: UserId; handoffCode?: string }
  | { status: 'new'; continuation: string }
  | { status: 'new'; emailVerificationRequired: true }
  | { status: 'link_required' }
  | { status: 'reauthenticated'; proof: string }
