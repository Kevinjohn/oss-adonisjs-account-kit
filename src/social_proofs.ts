// Social sensitive proofs: issuing and consuming short-lived reauthentication proofs.
import { lockUser, transaction } from './db.ts'
import { consumeRows } from './consume_rows.ts'
import { revision } from './credential_revision.ts'
import { E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID } from './errors.ts'
import { isSensitivePurpose } from './social_enums.ts'
import {
  requireAuthenticatedUser,
  calculateSocialExpiry,
  readSqlTimestamp,
  type Dependencies,
} from './social_shared.ts'
import { generateToken, hashToken, isTokenShaped } from './tokens.ts'
import type { CurrentAccountInput, ResolvedConfig, SensitivePurpose, Trx, UserId } from './types.ts'

export async function consumeSocialSensitiveProof(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  purpose: SensitivePurpose,
  proof: string
): Promise<void> {
  if (!isTokenShaped(proof)) throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
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
  const rows = await consumeRows<{ credential_revision: string | null }>(
    trx,
    'social_sensitive_proofs',
    { hash: proofHash, user_id: userId, purpose },
    readSqlTimestamp(trx)
  )
  if (rows.length !== 1 || rows[0].credential_revision !== (await revision(trx, config, userId)))
    throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
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
    expires_at: calculateSocialExpiry(trx),
    created_at: readSqlTimestamp(trx),
  })
  return proof
}

/** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
export async function proveSocialPassword(
  deps: Dependencies,
  input: {
    current: CurrentAccountInput
    password: string
    purpose: SensitivePurpose
  }
): Promise<string> {
  if (typeof input.password !== 'string' || !isSensitivePurpose(input.purpose) || !input.current)
    throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
  await deps.throttler.consume('identity:user', String(input.current.userId), deps.config.throttle)
  return transaction(deps.db, async (trx) => {
    const user = await requireAuthenticatedUser(deps, input.current, trx)
    if (
      !user.hasPassword ||
      !(await deps.config.users.verifyPassword(user.id, input.password, trx))
    )
      throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
    return issueProof(trx, deps.config, user.id, input.purpose)
  })
}
