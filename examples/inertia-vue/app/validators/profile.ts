import vine from '@vinejs/vine'
import { accountMessages } from '#validators/user'

export const updateProfileValidator = vine.create({
  fullName: vine.string().trim().maxLength(255).nullable().optional(),
  currentPassword: vine.string(),
})
updateProfileValidator.messagesProvider = accountMessages
