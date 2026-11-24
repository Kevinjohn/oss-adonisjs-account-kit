import { DateTime } from 'luxon'
import { isEmailShaped, normalizeEmail } from './email.js'
import { matchInvitation } from './invitation_match.js'
import { mapRegistrationFields } from './registration_fields.js'
import { mapSocialIdentityRow } from './social_links.js'
import {
  E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING,
  E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID,
} from './errors.js'
import { readSqlTimestamp, type Dependencies } from './social_shared.js'
import type { AccountUser, SocialIdentity, SocialProviderName, Trx, UserId } from './types.js'

export interface ProviderProfile {
  subject: string
  email: string | null
  emailVerified: boolean
  name?: string | null
  nickname?: string | null
  avatarUrl?: string | null
}

export function requireProviderProfile(value: ProviderProfile): ProviderProfile {
  if (
    !value ||
    typeof value.subject !== 'string' ||
    value.subject.length === 0 ||
    value.subject.length > 255
  )
    throw new E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID()
  if (value.email !== null && !isEmailShaped(value.email))
    throw new E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID()
  for (const key of ['name', 'nickname', 'avatarUrl'] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string')
      throw new E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID()
  }
  return {
    subject: value.subject,
    email: value.email === null ? null : normalizeEmail(value.email),
    emailVerified: value.emailVerified === true,
    name: value.name?.slice(0, 255) ?? null,
    nickname: value.nickname?.slice(0, 255) ?? null,
    avatarUrl: value.avatarUrl?.slice(0, 2048) ?? null,
  }
}

export async function createAssociation(
  trx: Trx,
  userId: UserId,
  name: SocialProviderName,
  profile: ProviderProfile,
  confirmed: boolean
): Promise<SocialIdentity> {
  const timestamp = readSqlTimestamp(trx)
  await trx.table('social_identities').insert({
    user_id: userId,
    provider: name,
    provider_user_id: profile.subject,
    email: profile.email,
    email_verified: profile.emailVerified,
    name: profile.name ?? null,
    nickname: profile.nickname ?? null,
    avatar_url: profile.avatarUrl ?? null,
    confirmed_at: confirmed ? timestamp : null,
    created_at: timestamp,
    updated_at: timestamp,
  })
  const created = await trx
    .from('social_identities')
    .where('provider', name)
    .where('provider_user_id', profile.subject)
    .first()
  if (!created) throw new E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID()
  return mapSocialIdentityRow(created)
}

export async function createAccount(
  deps: Dependencies,
  trx: Trx,
  name: SocialProviderName,
  profile: ProviderProfile,
  registrationData?: unknown,
  admit?: (
    profile: { provider: SocialProviderName; subject: string; email: string },
    trx: Trx
  ) => Promise<void>,
  onUserCreateFailure?: (error: unknown) => void
): Promise<{ user: AccountUser; relation: SocialIdentity; invitationIds: number[] }> {
  const registration = deps.config.registration!
  if (registration.availability === 'closed') throw new E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID()
  if (registration.availability === 'application' && !admit)
    throw new E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID()
  if (!profile.email) throw new E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING()
  if (admit) await admit({ provider: name, subject: profile.subject, email: profile.email }, trx)
  if (await deps.config.users.findByEmail(profile.email, trx))
    throw new E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID()
  const mapped = await mapRegistrationFields(deps.config, registrationData)
  let user: AccountUser
  try {
    user = await deps.config.users.create(
      {
        email: profile.email,
        unverifiedEmail: profile.emailVerified ? null : profile.email,
        password: null,
        registrationData: mapped,
      },
      trx
    )
  } catch (error) {
    onUserCreateFailure?.(error)
    throw error
  }
  const verifiedAt = DateTime.utc()
  if (profile.emailVerified) await deps.config.users.markEmailVerified(user.id, verifiedAt, trx)
  const relation = await createAssociation(trx, user.id, name, profile, profile.emailVerified)
  const invitationIds = profile.emailVerified
    ? await matchInvitation(deps.config, trx, user, verifiedAt)
    : []
  const latest = await deps.config.users.findById(user.id, trx)
  if (!latest) throw new E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID()
  return { user: latest, relation, invitationIds }
}
