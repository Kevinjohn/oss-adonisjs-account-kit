// Social sensitive proofs: issuing and consuming short-lived reauthentication proofs.
import { lockUser, transaction, deleteReturning } from './db.js'
import { revision } from './authentication.js'
import { SocialProofError } from './errors.js'
import { authenticated, expiry, now, type Dependencies } from './social_identity.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import type { CurrentAccountInput, ResolvedConfig, SensitivePurpose, Trx, UserId } from './types.js'

export async function consumeSocialSensitiveProof(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  purpose: SensitivePurpose,
  proof: string
): Promise<void> {
  if (!isTokenShaped(proof)) throw new SocialProofError()
  return consumeSocialSensitiveProofHash(trx, config, userId, purpose, hashToken(proof))
}

export async function consumeSocialSensitiveProofHash(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  purpose: SensitivePurpose,
  proofHash: string
): Promise<void> {
  await lockUser(trx, config, userId)
  const rows = await deleteReturning<{ credential_revision: string | null }>(
    trx,
    'delete from social_sensitive_proofs where hash = ? and user_id = ? and purpose = ? and expires_at > ? returning credential_revision',
    [proofHash, userId, purpose, now()]
  )
  if (rows.length !== 1 || rows[0].credential_revision !== (await revision(trx, config, userId)))
    throw new SocialProofError()
}

export async function issueProof(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  purpose: SensitivePurpose
): Promise<string> {
  const proof = generateToken()
  await trx.table('social_sensitive_proofs').insert({
    hash: hashToken(proof),
    user_id: userId,
    purpose,
    credential_revision: await revision(trx, config, userId),
    expires_at: expiry(),
    created_at: now(),
  })
  return proof
}

export async function proveSocialPassword(
  deps: Dependencies,
  input: {
    current: CurrentAccountInput
    password: string
    purpose: SensitivePurpose
  }
): Promise<string> {
  if (
    typeof input.password !== 'string' ||
    !['social_link', 'social_unlink', 'password_change', 'email_change'].includes(input.purpose)
  )
    throw new SocialProofError()
  return transaction(deps.db, async (trx) => {
    const user = await authenticated(deps, input.current, trx)
    if (
      !user.hasPassword ||
      !(await deps.config.users.verifyPassword(user.id, input.password, trx))
    )
      throw new SocialProofError()
    return issueProof(trx, deps.config, user.id, input.purpose)
  })
}
