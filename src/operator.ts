// Operator-context services: shell-trusted invitation and reset-link issuance for Ace commands.
import { randomUUID } from 'node:crypto'
import {
  finishCommitted,
  createLifecycleEffect,
  postCommit,
  settleCommitted,
  type PostCommitEffect,
} from './effects.js'
import { isInvitationRole } from './invitation_input.js'
import { isEmailShaped, normalizeEmail } from './email.js'
import {
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_USER_NOT_FOUND,
  type E_ACCOUNT_KIT_POST_COMMIT,
  E_ACCOUNT_KIT_EMAIL_INVALID,
} from './errors.js'
import { transaction } from './db.js'
import { replaceBootstrapInvitation } from './bootstrap_invitation.js'
import type { Invitation, Trx } from './types.js'
import { storeInvitation } from './invitations.js'
import { normalizeScope } from './invitation_scope.js'
import { issueResetToken } from './password_reset.js'
import { generateToken } from './tokens.js'
import type {
  OperatorFault,
  OperatorInviteInput,
  OperatorInviteResult,
  OperatorResetLinkInput,
  OperatorResetLinkResult,
} from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

function requireDelivery(value: unknown): asserts value is 'send' | 'print' {
  if (value !== 'send' && value !== 'print')
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid delivery')
}

function requireEmail(value: unknown): string {
  if (!isEmailShaped(value)) throw new E_ACCOUNT_KIT_EMAIL_INVALID()
  return normalizeEmail(value)
}

/** Run committed follow-ups and report any failure as safe data instead of throwing. */
async function followUps(
  committedFault: InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT> | undefined,
  message: string,
  effects: PostCommitEffect[]
): Promise<OperatorFault | undefined> {
  try {
    await finishCommitted(committedFault, message, () => postCommit(message, effects))
    return undefined
  } catch (error) {
    const failure = error as InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT>
    return { code: failure.code, name: failure.name, message: failure.message }
  }
}

/**
 * Issue an invitation without actor authorization or throttles. Any existing invitation for the
 * address and scope is replaced, so a rerun after a lost link is never blocked by the pending one.
 */
export async function issueStandaloneOperatorInvitation(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: OperatorInviteInput
): Promise<OperatorInviteResult> {
  return issueOperatorInvitation(deps, input)
}

/**
 * Internal composition for the admission approval written in the invitation transaction.
 *
 * @throws {AggregateError} Work and cleanup both failed. The work failure is first.
 */
export async function issueOperatorInvitation(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: OperatorInviteInput,
  bind?: (invitation: Invitation, trx: Trx) => Promise<void>
): Promise<OperatorInviteResult> {
  requireDelivery(input.deliver)
  const email = requireEmail(input.email)
  if (!isInvitationRole(input.role)) throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid role')
  if (await deps.config.users.findByEmail(email)) throw new E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED()

  const token = generateToken(deps.config.tokenSecretLength)
  const url = deps.config.urls.invitation(token)
  const { invitation, fault } = bind
    ? await settleCommitted(
        transaction(deps.db, async (trx) => {
          const replacement = await replaceBootstrapInvitation(deps.config, trx, {
            email,
            role: input.role,
            token,
          })
          await bind(replacement, trx)
          return replacement
        })
      ).then(({ value, fault: committedFault }) => ({ invitation: value, fault: committedFault }))
    : await storeInvitation(deps, {
        email,
        role: input.role,
        scope: normalizeScope(input.scope),
        inviterId: null,
        token,
        replacePending: true,
      })
  const effects: PostCommitEffect[] = [
    createLifecycleEffect(deps.config, {
      type: 'invitation.sent',
      invitationId: invitation.id,
      operationId: randomUUID(),
      source: 'operator',
    }),
  ]
  if (input.deliver === 'send')
    effects.unshift({
      kind: 'delivery',
      run: () => deps.config.notify.invitationProvision(invitation, url),
    })
  const followUpFault = await followUps(
    fault,
    'Invitation committed but follow-ups failed',
    effects
  )
  return {
    invitation,
    ...(input.deliver === 'print' ? { url } : {}),
    ...(followUpFault ? { fault: followUpFault } : {}),
  }
}

/**
 * Issue a password-reset link without throttles or the timing floor. Unknown addresses are
 * reported, because the operator already has database-level access.
 */
export async function issueOperatorResetLink(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: OperatorResetLinkInput
): Promise<OperatorResetLinkResult> {
  requireDelivery(input.deliver)
  const email = requireEmail(input.email)
  const user = await deps.config.users.findByEmail(email)
  if (!user) throw new E_ACCOUNT_KIT_USER_NOT_FOUND()

  const token = generateToken(deps.config.tokenSecretLength)
  const url = deps.config.urls.passwordReset(token)
  const { value: issued, fault } = await settleCommitted(
    issueResetToken(deps, user.id, email, token)
  )
  if (!issued) {
    if (fault) throw fault
    throw new E_ACCOUNT_KIT_USER_NOT_FOUND()
  }
  const effects: PostCommitEffect[] = [
    createLifecycleEffect(deps.config, {
      type: 'password_reset.requested',
      userId: issued.id,
      operationId: randomUUID(),
      source: 'operator',
    }),
  ]
  if (input.deliver === 'send')
    effects.unshift({
      kind: 'delivery',
      run: () => deps.config.notify.passwordResetProvision(issued, url),
    })
  const followUpFault = await followUps(fault, 'Recovery committed but follow-ups failed', effects)
  return {
    user: issued,
    ...(input.deliver === 'print' ? { url } : {}),
    ...(followUpFault ? { fault: followUpFault } : {}),
  }
}
