import vine from '@vinejs/vine'
import { email, password } from '#validators/user'

/**
 * A new password, typed twice.
 */
const newPassword = () => ({
  password: password(),
  passwordConfirmation: password().sameAs('password'),
})

export const forgotPasswordValidator = vine.create({
  email: email(),
})

export const resetPasswordValidator = vine.create(newPassword())

export const verifyEmailValidator = vine.create(newPassword())

export const changePasswordValidator = vine.create({
  currentPassword: vine.string(),
  ...newPassword(),
})
