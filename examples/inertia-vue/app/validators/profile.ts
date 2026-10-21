import vine from '@vinejs/vine'
import { accountMessages } from '#validators/user'

export const updateProfileValidator = vine.create({
  fullName: vine.string().trim().minLength(1).maxLength(255),
  currentPassword: vine.string(),
})
updateProfileValidator.messagesProvider = accountMessages
