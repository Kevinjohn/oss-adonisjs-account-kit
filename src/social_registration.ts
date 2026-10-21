import { randomUUID } from 'node:crypto'
import { transaction, isUserEmailUniqueViolation } from './db.js'
import { finishCommitted, postCommit, settleCommitted } from './effects.js'
import { invitationAccepted } from './invitation_match.js'
import { isEmailShaped } from './email.js'
import { createHandoff } from './social_handoff.js'
import {
  SocialEmailMissingError,
  SocialIdentityAlreadyLinkedError,
  SocialTransactionError,
} from './errors.js'
import { sendVerification } from './verification.js'
import { consumeState, isIdentityConflict } from './social_callback.js'
import { checkedProfile, createAccount } from './social_account_creation.js'
import { enabledProviders, type Dependencies } from './social_shared.js'
import type { SocialCallbackResult, SocialProviderName, Trx, UserId } from './types.js'

export async function completeRegistration(
  deps: Dependencies,
  input: {
    continuation: string
    email?: string
    registrationData?: unknown
    admit?: (
      profile: { provider: SocialProviderName; subject: string; email: string },
      trx: Trx
    ) => Promise<void>
  }
): Promise<SocialCallbackResult> {
  let unverified: UserId | undefined
  let accepted: { invitationId: number; userId: UserId } | undefined
  let settled: Awaited<ReturnType<typeof settleCommitted<SocialCallbackResult>>>
  try {
    settled = await settleCommitted(
      transaction(deps.db, async (trx): Promise<SocialCallbackResult> => {
        const state = await consumeState(trx, input.continuation)
        if (state.intent !== 'registration' || !state.provider_user_id)
          throw new SocialTransactionError()
        if (!enabledProviders(deps.config).includes(state.provider))
          throw new SocialTransactionError()
        const email = state.email ?? input.email
        if (!email || !isEmailShaped(email)) throw new SocialEmailMissingError()
        const profile = checkedProfile({
          subject: state.provider_user_id,
          email,
          emailVerified: state.email !== null && Boolean(state.email_verified),
          name: state.name,
          nickname: state.nickname,
          avatarUrl: state.avatar_url,
        })
        if (await deps.config.users.findByEmail(profile.email!, trx))
          return { status: 'link_required' }
        const created = await createAccount(
          deps,
          trx,
          state.provider,
          profile,
          input.registrationData,
          input.admit
        )
        if (created.invitationId !== null)
          accepted = { invitationId: created.invitationId, userId: created.user.id }
        if (!profile.emailVerified) {
          unverified = created.user.id
          return { status: 'new' as const, emailVerificationRequired: true as const }
        }
        return {
          status: 'new' as const,
          userId: created.user.id,
          handoffCode: await createHandoff(
            trx,
            deps.config,
            created.user.id,
            created.relation.id,
            state.client_challenge
          ),
        }
      })
    )
  } catch (error) {
    if (isIdentityConflict(error)) throw new SocialIdentityAlreadyLinkedError()
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
      return { status: 'link_required' }
    throw error
  }
  await finishCommitted(
    settled.fault,
    'Social registration committed but follow-up failed',
    async () => {
      if (accepted)
        await postCommit(
          'Invitation follow-up failed',
          invitationAccepted(deps.config, accepted.invitationId, accepted.userId, randomUUID())
        )
      if (unverified && deps.config.enabled.includes('emailVerification')) {
        await sendVerification(deps, { userId: unverified })
      }
    }
  )
  return settled.value
}
