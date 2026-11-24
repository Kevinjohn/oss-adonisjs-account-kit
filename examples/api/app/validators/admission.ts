import vine from '@vinejs/vine'
import { E_ACCOUNT_KIT_INVALID_INPUT } from '@kevinjohn/adonisjs-account-kit'

export const admissionListValidator = vine.create({
  status: vine.enum(['pending', 'approved', 'rejected', 'revoked'] as const).optional(),
  limit: vine.number().min(1).max(100).optional(),
  cursor: vine.string().optional(),
})

/** Integer ids must be positive integers, so a database never receives a malformed id. */
export function userIdParam(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64)
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid user ID')
  const id = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(id)) throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid user ID')
  return id
}
