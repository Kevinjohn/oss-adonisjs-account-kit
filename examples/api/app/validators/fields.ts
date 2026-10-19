import vine from '@vinejs/vine'

/** Shared email rule for sign-in, signup, recovery, invitations and profile changes. */
export const email = () => vine.string().trim().toLowerCase().email().maxLength(254)

/** Shared display-name rule for signup, social registration, invitations and profile changes. */
export const fullName = () => vine.string().trim().minLength(1).maxLength(100)
