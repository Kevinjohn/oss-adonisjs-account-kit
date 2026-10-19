// Operator-context services: shell-trusted invitation and reset-link issuance for Ace commands.
import { randomUUID } from 'node:crypto'
import {
  finishCommitted,
  lifecycle,
  postCommit,
  settleCommitted,
  type PostCommitEffect,
} from './effects.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import {
  EmailAlreadyRegisteredError,
  InvalidInputError,
  UserNotFoundError,
  type PostCommitError,
} from './errors.js'
import { storeInvitation } from './invitations.js'
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
  if (value !== 'send' && value !== 'print') throw new InvalidInputError('Invalid delivery')
}

function requireEmail(value: unknown): string {
  if (!isEmailShaped(value)) throw new InvalidInputError('Invalid email')
  return normaliseEmail(value)
}

/** Run committed follow-ups and report any failure as safe data instead of throwing. */
async function followUps(
  committedFault: PostCommitError | undefined,
  message: string,
  effects: PostCommitEffect[]
): Promise<OperatorFault | undefined> {
  try {
    await finishCommitted(committedFault, message, () => postCommit(message, effects))
    return undefined
  } catch (error) {
    const failure = error as Error
    return { name: failure.name, message: failure.message }
  }
}

/**
 * Issue an invitation without actor authorisation or throttles. Any existing invitation for the
 * address is replaced, so a rerun after a lost link is never blocked by the pending one.
 */
export async function operatorInvite(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: OperatorInviteInput
): Promise<OperatorInviteResult> {
  requireDelivery(input.deliver)
  const email = requireEmail(input.email)
  if (typeof input.role !== 'string' || input.role.length < 1 || input.role.length > 64)
    throw new InvalidInputError('Invalid role')
  if (await deps.config.users.findByEmail(email)) throw new EmailAlreadyRegisteredError()

  const token = generateToken(deps.config.tokenSecretLength)
  const url = deps.config.urls.invitation(token)
  const { invitation, fault } = await storeInvitation(deps, {
    email,
    role: input.role,
    inviterId: null,
    token,
    replacePending: true,
  })
  const effects: PostCommitEffect[] = [
    lifecycle(deps.config, {
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
export async function operatorResetLink(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: OperatorResetLinkInput
): Promise<OperatorResetLinkResult> {
  requireDelivery(input.deliver)
  const email = requireEmail(input.email)
  const user = await deps.config.users.findByEmail(email)
  if (!user) throw new UserNotFoundError()

  const token = generateToken(deps.config.tokenSecretLength)
  const { value: issued, fault } = await settleCommitted(
    issueResetToken(deps, user.id, email, token)
  )
  if (!issued) {
    if (fault) throw fault
    throw new UserNotFoundError()
  }
  const url = deps.config.urls.passwordReset(token)
  const effects: PostCommitEffect[] = [
    lifecycle(deps.config, {
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
