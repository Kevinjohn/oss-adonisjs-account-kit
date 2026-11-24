// Social handoff codes: issuing a one-time code after a social callback and redeeming it for a credential.
import { requireAccountAccessDecision } from './account_access_decision.js'
import { sqlTimestamp } from './timestamps.js'
import { establishCredential } from './credential_issuance.js'
import { DateTime } from 'luxon'
import { revision } from './credential_revision.js'
import { buildAccountProjection } from './account_projection.js'
import { lockUser, transaction } from './db.js'
import { consumeRows } from './consume_rows.js'
import { isClientVerifier, verifierMatches } from './client_challenge.js'
import { SocialTransactionError } from './errors.js'
import { listEnabledSocialProviders, readSqlTimestamp, type Dependencies } from './social_shared.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import type {
  AuthenticationGuard,
  CurrentAccount,
  ResolvedConfig,
  SocialProviderName,
  Trx,
  UserId,
} from './types.js'

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
    expires_at: sqlTimestamp(trx, DateTime.utc().plus({ minutes: 2 })),
    created_at: readSqlTimestamp(trx),
  })
  return code
}

async function getUsableHandoffProvider(
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
  return row && listEnabledSocialProviders(config).includes(row.provider)
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
    !isClientVerifier(input.verifier) ||
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
    const rows = await consumeRows<typeof candidate>(
      trx,
      'social_handoff_codes',
      { hash: hashToken(input.code) },
      readSqlTimestamp(trx)
    )
    const row = rows[0]
    if (
      !row ||
      row.user_id !== candidate.user_id ||
      !verifierMatches(input.verifier, row.client_challenge)
    )
      throw new SocialTransactionError()
    const user = await deps.config.users.findById(row.user_id, trx)
    if (!user || !requireAccountAccessDecision(await auth.canAccess(user, trx)))
      throw new SocialTransactionError()
    const currentRevision = await revision(trx, deps.config, user.id)
    const establishedProvider = await getUsableHandoffProvider(
      trx,
      deps.config,
      user.id,
      row.social_identity_id
    )
    if (currentRevision !== row.credential_revision || !establishedProvider)
      throw new SocialTransactionError()
    return {
      account: buildAccountProjection(user),
      revision: currentRevision,
      socialIdentityId: row.social_identity_id as number,
      provider: establishedProvider,
    }
  })
  const credential = await establishCredential(deps, auth, input.guard, verified, {
    stillValid: async (trx, user) =>
      (await getUsableHandoffProvider(trx, deps.config, user.id, verified.socialIdentityId)) ===
      verified.provider,
    rejected: () => new SocialTransactionError(),
    cleanupFailed: 'Social credential cleanup failed',
  })
  return { account: verified.account, credential, provider: verified.provider }
}
