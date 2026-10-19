import vine from '@vinejs/vine'
import { email, fullName } from '#validators/fields'
import { password } from '#validators/password'

export const recoveryRequestValidator = vine.create({ email: email() })
/** A new password and its confirmation, for password reset and email verification. */
export const passwordValidator = vine.create({
  password: password(),
  passwordConfirmation: vine.string().sameAs('password'),
})
export const invitationAcceptValidator = vine.create({
  password: password(),
  passwordConfirmation: vine.string().sameAs('password'),
  fullName: fullName(),
})
export const invitationValidator = vine.create({
  email: email(),
  role: vine.string().trim().minLength(1),
})
export const invitationListValidator = vine.create({
  limit: vine.number().min(1).max(100).optional(),
  cursor: vine.string().optional(),
})
export const credentialChangeValidator = vine.create({
  currentPassword: vine.string().minLength(1),
  newPassword: password(),
  newPasswordConfirmation: vine.string().sameAs('newPassword'),
})
export const profileUpdateValidator = vine.create({
  currentPassword: vine.string().minLength(1),
  email: email().optional(),
  fullName: fullName().optional(),
})
