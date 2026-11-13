import { InvalidInputError } from './errors.js'
import type { ResolvedConfig } from './types.js'

/** Lower-cased account field names that registration data may never set. */
export const PROTECTED_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'email',
  'unverifiedemail',
  'unverified_email',
  'password',
  'passwordhash',
  'password_hash',
  'emailverifiedat',
  'email_verified_at',
  'credentialschangedat',
  'credentials_changed_at',
  'role',
  'roles',
])

/** Map untrusted account-creation fields through application policy before reaching an adapter. */
export async function mapRegistrationFields(
  config: Pick<ResolvedConfig, 'registration'>,
  input: unknown
): Promise<Record<string, unknown> | undefined> {
  if (!config.registration?.mapFields) {
    if (input === undefined) return undefined
    throw new InvalidInputError('Registration fields are not configured')
  }
  const data = await config.registration.mapFields(input)
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) ||
    Object.keys(data).some((key) => PROTECTED_FIELDS.has(key.toLowerCase()))
  )
    throw new InvalidInputError('Invalid registration fields')
  return data
}
