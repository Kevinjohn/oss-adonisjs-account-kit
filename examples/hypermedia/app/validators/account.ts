import vine from '@vinejs/vine'
import { accountMessages, email, password } from '#validators/user'

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
forgotPasswordValidator.messagesProvider = accountMessages

export const resetPasswordValidator = vine.create(newPassword())
resetPasswordValidator.messagesProvider = accountMessages

export const verifyEmailValidator = vine.create(newPassword())
verifyEmailValidator.messagesProvider = accountMessages

export const changePasswordValidator = vine.create({
  currentPassword: vine.string(),
  ...newPassword(),
})
changePasswordValidator.messagesProvider = accountMessages
