// Social handoff codes: issuing a one-time code after a social callback and redeeming it for a credential.
import { establishCredential } from './credential_issuance.js'
import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'
import { revision, safeAccount } from './authentication.js'
import { deleteReturning, lockUser, transaction } from './db.js'
import { SocialTransactionError } from './errors.js'
import { enabledProviders, now, type Dependencies } from './social_identity.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import type {
  AuthenticationGuard,
  CurrentAccount,
  ResolvedConfig,
  SocialProviderName,
  Trx,
  UserId,
} from './types.js'

const challengeFrom = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url')

export async function createHandoff(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  socialIdentityId: number,
  clientChallenge: string
): Promise<string> {
  const code = generateToken(32)
  await trx.table('social_handoff_codes').insert({
    hash: hashToken(code),
    user_id: userId,
    social_identity_id: socialIdentityId,
    credential_revision: await revision(trx, config, userId),
    client_challenge: clientChallenge,
    expires_at: DateTime.utc().plus({ minutes: 2 }).toISO(),
    created_at: now(),
  })
  return code
}

async function usableHandoffAssociation(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  socialIdentityId: number
): Promise<SocialProviderName | null> {
  const row = await trx
    .from('social_identities')
    .where('id', socialIdentityId)
    .where('user_id', userId)
    .whereNotNull('confirmed_at')
    .first()
  return row && enabledProviders(config).includes(row.provider)
    ? (row.provider as SocialProviderName)
    : null
}

export async function redeemSocialHandoff<Credential>(
  deps: Dependencies,
  input: {
    code: string
    verifier: string
    guard: AuthenticationGuard<Credential>
  }
): Promise<{ account: CurrentAccount; credential: Credential; provider: SocialProviderName }> {
  const auth = deps.config.authentication!
  if (
    !isTokenShaped(input.code) ||
    typeof input.verifier !== 'string' ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) ||
    input.guard.strategy !== auth.strategy ||
    input.guard.name !== auth.guard
  )
    throw new SocialTransactionError()
  const verified = await transaction(deps.db, async (trx) => {
    const candidate = await trx
      .from('social_handoff_codes')
      .where('hash', hashToken(input.code))
      .first()
    if (!candidate) throw new SocialTransactionError()
    await lockUser(trx, deps.config, candidate.user_id)
    const rows = await deleteReturning<typeof candidate>(
      trx,
      'delete from social_handoff_codes where hash = ? and expires_at > ? returning *',
      [hashToken(input.code), now()]
    )
    const row = rows[0]
    if (
      !row ||
      row.user_id !== candidate.user_id ||
      row.client_challenge !== challengeFrom(input.verifier)
    )
      throw new SocialTransactionError()
    const user = await deps.config.users.findById(row.user_id, trx)
    if (!user || !(await auth.canAccess(user, trx))) throw new SocialTransactionError()
    const currentRevision = await revision(trx, deps.config, user.id)
    const establishedProvider = await usableHandoffAssociation(
      trx,
      deps.config,
      user.id,
      row.social_identity_id
    )
    if (currentRevision !== row.credential_revision || !establishedProvider)
      throw new SocialTransactionError()
    return {
      account: safeAccount(user),
      revision: currentRevision,
      socialIdentityId: row.social_identity_id as number,
      provider: establishedProvider,
    }
  })
  const credential = await establishCredential(deps, auth, input.guard, verified, {
    stillValid: async (trx, user) =>
      (await usableHandoffAssociation(trx, deps.config, user.id, verified.socialIdentityId)) ===
      verified.provider,
    rejected: () => new SocialTransactionError(),
    cleanupFailed: 'Social credential cleanup failed',
  })
  return { account: verified.account, credential, provider: verified.provider }
}
