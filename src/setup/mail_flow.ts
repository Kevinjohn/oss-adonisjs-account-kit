import type { SetupChoices, SetupFeature } from './types.js'

export const emailDestinations: Partial<
  Record<SetupFeature, keyof SetupChoices['mail']['destinations']>
> = {
  registration: 'emailVerification',
  emailVerification: 'emailVerification',
  passwordReset: 'passwordReset',
  invitations: 'invitation',
  emailPasswordManagement: 'emailChange',
  magicLinkLogin: 'magicLink',
}

export function hasEmailFlow(choices: SetupChoices): boolean {
  return choices.features.some((feature) => feature in emailDestinations)
}

export const nativeMailTransports = new Set([
  'smtp',
  'ses',
  'mailgun',
  'sparkpost',
  'resend',
  'brevo',
  'postmark',
])
