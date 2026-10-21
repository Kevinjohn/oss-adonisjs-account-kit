import vine, { SimpleMessagesProvider } from '@vinejs/vine'
import { accountMessages, email } from '#validators/user'

export const requestEmailChangeValidator = vine.create({
  email: email(),
  currentPassword: vine.string(),
})
requestEmailChangeValidator.messagesProvider = accountMessages

export const cancelEmailChangeValidator = vine.create({
  cancelCurrentPassword: vine.string(),
})
cancelEmailChangeValidator.messagesProvider = new SimpleMessagesProvider({
  'cancelCurrentPassword.required': 'Enter your current password.',
})
