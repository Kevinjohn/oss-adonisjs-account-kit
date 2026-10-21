import app from '@adonisjs/core/services/app'
import { AccountAccessDeniedError, AccountKit } from 'adonisjs-account-kit'
import { isAdmittedOwner } from './account_kit_authorization.js'

type AuthenticatedActor = { id: number | string }

/** Inspect an account only after the authenticated application actor passes its owner policy. */
export async function inspectAccountForOwner(
  actor: AuthenticatedActor,
  targetUserId: number | string
) {
  if (!(await isAdmittedOwner(actor.id))) return null

  const accountKit = await app.container.make(AccountKit)
  try {
    return await accountKit.authentication.inspectAccountAccess({
      userId: targetUserId,
      requireActive: false,
    })
  } catch (error) {
    if (error instanceof AccountAccessDeniedError) return null
    throw error
  }
}

/** Compare a protected captured revision with a fresh inspection after reauthorizing the caller. */
export async function compareAccountRevisionForOwner(
  actor: AuthenticatedActor,
  targetUserId: number | string,
  expectedRevision: string | null
) {
  if (!(await isAdmittedOwner(actor.id))) return { outcome: 'denied' as const }

  const accountKit = await app.container.make(AccountKit)
  let current
  try {
    current = await accountKit.authentication.inspectAccountAccess({
      userId: targetUserId,
      requireActive: false,
    })
  } catch (error) {
    if (error instanceof AccountAccessDeniedError) return { outcome: 'denied' as const }
    throw error
  }
  if (current.revision !== expectedRevision) return { outcome: 'changed' as const }
  return { outcome: 'current' as const, snapshot: current }
}
