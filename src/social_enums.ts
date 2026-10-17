// Single source of truth for social flow intents and sensitive-action purposes.
// Kept apart from social_providers.ts: that file is about who the provider is, this one about what the flow is for.
import type { SensitivePurpose, SocialIntent } from './types.js'

export const socialIntents = ['login', 'link', 'reauth', 'confirm'] as const

export const sensitivePurposes = [
  'social_link',
  'social_unlink',
  'password_change',
  'email_change',
] as const

export function isSocialIntent(value: unknown): value is SocialIntent {
  return (socialIntents as readonly unknown[]).includes(value)
}

/** Intents a client may start; `confirm` only completes a pending link. */
export function isSocialBeginIntent(value: unknown): value is Exclude<SocialIntent, 'confirm'> {
  return isSocialIntent(value) && value !== 'confirm'
}

export function isSensitivePurpose(value: unknown): value is SensitivePurpose {
  return (sensitivePurposes as readonly unknown[]).includes(value)
}
