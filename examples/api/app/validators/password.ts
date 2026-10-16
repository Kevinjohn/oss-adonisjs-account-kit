import vine from '@vinejs/vine'

/** The reference keeps its request rules aligned with its configured service policy. */
export const referencePasswordLimits = { minLength: 8, maxLength: 256 } as const

/** Shared password policy for credentials created or changed by a user. */
export const password = () =>
  vine
    .string()
    .minLength(referencePasswordLimits.minLength)
    .maxLength(referencePasswordLimits.maxLength)
