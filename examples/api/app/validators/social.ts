import vine from '@vinejs/vine'
import type { SensitivePurpose, SocialIntent } from 'adonisjs-account-kit'
import { authStrategy } from '#services/auth_strategy'

const beginIntents = ['login', 'link', 'reauth'] as const satisfies readonly SocialIntent[]
const intents = [...beginIntents, 'confirm'] as const satisfies readonly SocialIntent[]
const purposes = [
  'social_link',
  'social_unlink',
  'password_change',
  'email_change',
  'account_export',
  'account_delete',
] as const satisfies readonly SensitivePurpose[]

/** Token clients send their own PKCE challenge; session clients get one from the server. */
const clientChallenge = () =>
  vine
    .string()
    .minLength(1)
    .optional()
    .requiredWhen(() => authStrategy() !== 'session')

export const socialRedirectValidator = vine.create({
  intent: vine.enum(beginIntents).optional(),
  purpose: vine.enum(purposes).optional(),
  proof: vine.string().minLength(1).optional(),
  clientChallenge: clientChallenge(),
})

export const socialConfirmValidator = vine.create({
  verificationToken: vine.string().minLength(1),
  clientChallenge: clientChallenge(),
})

export const socialCallbackValidator = vine.create({
  state: vine.string().minLength(1),
  intent: vine.enum(intents).optional(),
})

export const tokenRedeemValidator = vine.create({
  code: vine.string().minLength(1),
  verifier: vine.string().minLength(1),
})

export const passwordProofValidator = vine.create({
  password: vine.string().minLength(1),
  purpose: vine.enum(purposes),
})

export const socialUnlinkValidator = vine.create({
  proof: vine.string().minLength(1),
})
