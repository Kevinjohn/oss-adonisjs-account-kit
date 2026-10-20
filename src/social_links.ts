// The caller's linked providers: listing and unlinking.
import { randomUUID } from 'node:crypto'
import { credentialsChanged } from './authentication.js'
import { transaction } from './db.js'
import { finishCommitted, postCommit, settleCommitted, type PostCommitEffect } from './effects.js'
import { consumeSocialSensitiveProof } from './social_proofs.js'
import { LastLoginMethodError, SocialUserNotFoundError } from './errors.js'
import { authenticated, enabledProviders, type Dependencies } from './social_shared.js'
import type {
  AccountUser,
  CurrentAccountInput,
  SocialIdentity,
  SocialProviderName,
  UserId,
} from './types.js'

export function identity(row: Record<string, unknown>): SocialIdentity {
  return {
    id: Number(row.id),
    userId: row.user_id as UserId,
    provider: row.provider as SocialProviderName,
    providerUserId: row.provider_user_id as string,
    email: row.email as string | null,
    emailVerified: row.email_verified === true || row.email_verified === 1,
  }
}

export function confirmedRecipient(user: AccountUser): boolean {
  return user.emailVerifiedAt !== null && user.unverifiedEmail !== user.email
}

/** The caller's confirmed linked providers. */
export async function listSocialIdentities(
  deps: Dependencies,
  input: { current: CurrentAccountInput }
): Promise<SocialIdentity[]> {
  return transaction(deps.db, async (trx) => {
    const user = await authenticated(deps, input.current, trx)
    const rows = await trx
      .from('social_identities')
      .where('user_id', user.id)
      .whereNotNull('confirmed_at')
      .orderBy('id', 'asc')
    return rows.map(identity)
  })
}

/**
 * Unlinks a provider with a `social_unlink` proof, keeping at least one way to sign in. A
 * credential change: older sessions and tokens end.
 */
export async function unlinkSocialIdentity(
  deps: Dependencies,
  input: { current: CurrentAccountInput; identityId: number; proof: string }
): Promise<void> {
  let notice: { user: AccountUser; relation: SocialIdentity } | undefined
  let changed: AccountUser | undefined
  const operationId = randomUUID()
  const { fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      const user = await authenticated(deps, input.current, trx)
      const row = await trx
        .from('social_identities')
        .where('id', input.identityId)
        .where('user_id', user.id)
        .first()
      if (!row) throw new SocialUserNotFoundError()
      await consumeSocialSensitiveProof(trx, deps.config, user.id, 'social_unlink', input.proof)
      const remaining = await trx
        .from('social_identities')
        .where('user_id', user.id)
        .whereNot('id', input.identityId)
        .whereNotNull('confirmed_at')
        .whereIn('provider', enabledProviders(deps.config))
        .count('* as total')
        .first()
      if (!user.hasPassword && Number(remaining?.total ?? 0) === 0) throw new LastLoginMethodError()
      await trx
        .from('social_identities')
        .where('id', input.identityId)
        .where('user_id', user.id)
        .delete()
      // Removing a login method is a credential change: advance the revision so sessions
      // and tokens established through the provider end, clear pending callbacks (including
      // one already resolving provider assurance, so a later relink cannot revive it) and
      // sensitive proofs, and run the application's transactional hook.
      changed = (await deps.config.users.findById(user.id, trx)) ?? user
      await credentialsChanged(trx, deps.config, changed, {
        operation: 'social_unlink',
        operationId,
        userId: user.id,
      })
      if (row.confirmed_at) notice = { user, relation: identity(row) }
    })
  )
  await finishCommitted(fault, 'Social unlink committed but follow-up failed', async () => {
    const effects: PostCommitEffect[] = []
    if (changed) {
      const user = changed
      effects.push({
        kind: 'observer',
        run: async () => {
          await deps.config.onCredentialsChanged?.(user, {
            operation: 'social_unlink',
            operationId,
            userId: user.id,
          })
        },
      })
    }
    if (notice && confirmedRecipient(notice.user)) {
      const { user, relation } = notice
      effects.push({
        kind: 'delivery',
        run: () => deps.config.notify.socialIdentityUnlinked(user, relation),
      })
    }
    if (effects.length) await postCommit('Social identity unlinked but a follow-up failed', effects)
  })
}
