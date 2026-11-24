import { randomUUID } from 'node:crypto'
import { transaction, isUserEmailUniqueViolation } from './db.js'
import { finishCommitted, postCommit, settleCommitted } from './effects.js'
import { emitInvitationAccepted } from './invitation_match.js'
import { isEmailShaped } from './email.js'
import { createHandoff } from './social_handoff.js'
import {
  E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING,
  E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED,
  E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID,
} from './errors.js'
import { sendSocialActivation } from './social_activation.js'
import { consumeState, isIdentityConflict } from './social_callback.js'
import { requireProviderProfile, createAccount } from './social_account_creation.js'
import {
  listEnabledSocialProviders,
  type Dependencies,
  type SocialTransactionResult,
} from './social_shared.js'
import type { SocialCallbackResult, SocialProviderName, Trx } from './types.js'

/** @throws {AggregateError} Work and cleanup both failed. The work failure is first. */
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
  let settled: Awaited<ReturnType<typeof settleCommitted<SocialTransactionResult>>>
  try {
    settled = await settleCommitted(
      transaction(deps.db, async (trx): Promise<SocialTransactionResult> => {
        const state = await consumeState(trx, input.continuation)
        if (state.intent !== 'registration' || !state.provider_user_id)
          throw new E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID()
        if (!listEnabledSocialProviders(deps.config).includes(state.provider))
          throw new E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID()
        const email = state.email ?? input.email
        if (!email || !isEmailShaped(email)) throw new E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING()
        const profile = requireProviderProfile({
          subject: state.provider_user_id,
          email,
          emailVerified: state.email !== null && Boolean(state.email_verified),
          name: state.name,
          nickname: state.nickname,
          avatarUrl: state.avatar_url,
        })
        if (await deps.config.users.findByEmail(profile.email!, trx))
          return { result: { status: 'link_required' } }
        const created = await createAccount(
          deps,
          trx,
          state.provider,
          profile,
          input.registrationData,
          input.admit
        )
        const accepted =
          created.invitationIds.length > 0
            ? { invitationIds: created.invitationIds, userId: created.user.id }
            : undefined
        if (!profile.emailVerified) {
          return {
            result: { status: 'new', emailVerificationRequired: true },
            unverified: created.user.id,
            accepted,
          }
        }
        return {
          accepted,
          result: {
            status: 'new',
            userId: created.user.id,
            handoffCode: await createHandoff(
              trx,
              deps.config,
              created.user.id,
              created.relation.id,
              state.client_challenge
            ),
          },
        }
      })
    )
  } catch (error) {
    if (isIdentityConflict(error)) throw new E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED()
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
      return { status: 'link_required' }
    throw error
  }
  const { result, unverified, accepted } = settled.value
  await finishCommitted(
    settled.fault,
    'Social registration committed but follow-up failed',
    async () => {
      if (accepted)
        await postCommit(
          'Invitation follow-up failed',
          emitInvitationAccepted(deps.config, accepted.invitationIds, accepted.userId, randomUUID())
        )
      if (unverified && deps.config.enabled.includes('emailVerification')) {
        await sendSocialActivation(deps, unverified)
      }
    }
  )
  return result
}
