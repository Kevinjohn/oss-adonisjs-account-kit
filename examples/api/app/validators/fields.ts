import vine from '@vinejs/vine'

/** Shared email rule for sign-in, signup, recovery, invitations and profile changes. */
export const email = () => vine.string().trim().toLowerCase().email().maxLength(254)

/** Optional display name for registration, social completion, invitations, and profile changes. */
export const optionalFullName = () => vine.string().trim().maxLength(255).nullable().optional()
