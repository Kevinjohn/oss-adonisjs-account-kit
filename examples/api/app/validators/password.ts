import vine from '@vinejs/vine'

/** Shared password policy for credentials created or changed by a user. */
export const password = () => vine.string().minLength(8).maxLength(128)
