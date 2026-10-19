// Single source of truth for the supported social provider names and their display labels.
import type { SocialProviderName } from './types.js'

/** The supported social providers. */
export const socialProviderNames = ['google', 'github'] as const

export const socialProviderLabels: Record<SocialProviderName, string> = {
  google: 'Google',
  github: 'GitHub',
}

export function isSocialProviderName(value: unknown): value is SocialProviderName {
  return (socialProviderNames as readonly unknown[]).includes(value)
}
