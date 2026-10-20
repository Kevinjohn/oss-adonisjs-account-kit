// Login-method retirement impact: counts accounts that would lose every way to sign in.
import { userMetadata } from './db.js'
import { isSocialProviderName } from './social_providers.js'
import type { SocialProviderName, UserId } from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

export async function retirementImpact(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: {
    passwordLogin: boolean
    providers?: readonly SocialProviderName[]
  }
): Promise<{
  inspectedAccounts: number
  affectedAccounts: number
  checkedAt: string
  currentProviders: SocialProviderName[]
  currentPasswordLogin: boolean
}> {
  if (typeof input.passwordLogin !== 'boolean')
    throw new Error('Remaining password-login policy must be selected explicitly')
  if (
    input.providers &&
    (new Set(input.providers).size !== input.providers.length ||
      input.providers.some((provider) => !isSocialProviderName(provider)))
  )
    throw new Error('Remaining provider inventory must use unique supported providers')
  const currentProviders = new Set(
    deps.config.enabled.includes('socialAuthentication')
      ? (Object.keys(deps.config.socialAuthentication?.providers ?? {}) as SocialProviderName[])
      : []
  )
  const remainingProviders = input.providers ?? [...currentProviders]
  const { table } = await userMetadata(deps.config)
  let inspectedAccounts = 0
  let affectedAccounts = 0
  let lastId: UserId | undefined
  for (;;) {
    const query = deps.db.from(table).select('id').orderBy('id', 'asc').limit(500)
    if (lastId !== undefined) query.where('id', '>', lastId)
    const rows = await query
    if (!rows.length) break
    const identities = currentProviders.size
      ? await deps.db
          .from('social_identities')
          .whereIn(
            'user_id',
            rows.map((row) => row.id as UserId)
          )
          .whereNotNull('confirmed_at')
          .select('user_id', 'provider')
      : []
    const byUser = new Map<string, Set<string>>()
    for (const identity of identities) {
      if (!isSocialProviderName(identity.provider))
        throw new Error('Unknown confirmed provider in login inventory')
      const key = String(identity.user_id)
      const values = byUser.get(key) ?? new Set<string>()
      values.add(identity.provider)
      byUser.set(key, values)
    }
    for (const row of rows) {
      const id = row.id as UserId
      const user = await deps.config.users.findById(id)
      if (!user) throw new Error('Account adapter could not resolve an inventoried user')
      if (typeof user.hasPassword !== 'boolean')
        throw new Error('Account adapter must report whether each inventoried user has a password')
      inspectedAccounts++
      const confirmed = byUser.get(String(id)) ?? new Set<string>()
      const hadUsableMethod =
        user.hasPassword ||
        [...confirmed].some((provider) => currentProviders.has(provider as SocialProviderName))
      const retainsMethod =
        (input.passwordLogin && user.hasPassword) ||
        remainingProviders.some(
          (provider) => currentProviders.has(provider) && confirmed.has(provider)
        )
      if (hadUsableMethod && !retainsMethod) affectedAccounts++
      lastId = id
    }
  }
  return {
    inspectedAccounts,
    affectedAccounts,
    checkedAt: new Date().toISOString(),
    currentProviders: [...currentProviders],
    currentPasswordLogin: true,
  }
}
