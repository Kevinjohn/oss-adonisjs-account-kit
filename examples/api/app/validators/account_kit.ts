import vine from '@vinejs/vine'
import { password } from '#validators/password'

export const recoveryRequestValidator = vine.compile(
  vine.object({ email: vine.string().trim().toLowerCase().email().maxLength(254) })
)
export const passwordValidator = vine.compile(
  vine.object({
    password: password(),
    passwordConfirmation: vine.string().sameAs('password'),
  })
)
export const verificationCompleteValidator = vine.compile(
  vine.object({
    password: password(),
    passwordConfirmation: vine.string().sameAs('password'),
  })
)
export const invitationAcceptValidator = vine.compile(
  vine.object({
    password: password(),
    passwordConfirmation: vine.string().sameAs('password'),
    fullName: vine.string().trim().minLength(1).maxLength(100),
  })
)
export const invitationValidator = vine.compile(
  vine.object({
    email: vine.string().trim().toLowerCase().email().maxLength(254),
    role: vine.string().trim().minLength(1),
  })
)
export const invitationListValidator = vine.compile(
  vine.object({
    limit: vine.number().min(1).max(100).optional(),
    cursor: vine.string().optional(),
  })
)
export const credentialChangeValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().minLength(1),
    newPassword: password(),
    newPasswordConfirmation: vine.string().sameAs('newPassword'),
  })
)
export const emailChangeValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().minLength(1),
    newEmail: vine.string().trim().toLowerCase().email().maxLength(254),
  })
)
