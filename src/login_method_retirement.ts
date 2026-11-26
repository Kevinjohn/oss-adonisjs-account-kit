import { InvalidArgumentsException, RuntimeException } from '@adonisjs/core/exceptions'
// Login-method retirement impact: counts accounts that would lose every way to sign in.
import { requireUserMetadata } from './db.ts'
import { isSocialProviderName } from './social_providers.ts'
import type { SocialProviderName, UserId } from './types.ts'
import type { ServiceDependencies } from './service_dependencies.ts'

export async function assessRetirementImpact(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: {
    passwordLogin: boolean
    providers?: readonly SocialProviderName[]
    onlyWhenRetiring?: boolean
  }
): Promise<{
  inspectedAccounts: number
  affectedAccounts: number
  checkedAt: string
  currentProviders: SocialProviderName[]
  currentPasswordLogin: boolean
}> {
  if (typeof input.passwordLogin !== 'boolean')
    throw new InvalidArgumentsException(
      'Remaining password-login policy must be selected explicitly'
    )
  if (input.onlyWhenRetiring !== undefined && typeof input.onlyWhenRetiring !== 'boolean')
    throw new InvalidArgumentsException('Retirement-only inventory option must be a boolean')
  if (
    input.providers &&
    (new Set(input.providers).size !== input.providers.length ||
      input.providers.some((provider) => !isSocialProviderName(provider)))
  )
    throw new InvalidArgumentsException(
      'Remaining provider inventory must use unique supported providers'
    )
  const currentProviders = new Set(
    deps.config.enabled.includes('socialAuthentication')
      ? (Object.keys(deps.config.socialAuthentication?.providers ?? {}) as SocialProviderName[])
      : []
  )
  const currentPasswordLogin = Boolean(deps.config.authentication)
  const remainingProviders = input.providers ?? [...currentProviders]
  if (
    (!currentPasswordLogin && currentProviders.size === 0) ||
    (input.onlyWhenRetiring &&
      (!currentPasswordLogin || input.passwordLogin) &&
      [...currentProviders].every((provider) => remainingProviders.includes(provider)))
  )
    return {
      inspectedAccounts: 0,
      affectedAccounts: 0,
      checkedAt: new Date().toISOString(),
      currentProviders: [...currentProviders],
      currentPasswordLogin,
    }

  const users = deps.config.users
  const { table } = await requireUserMetadata(deps.config)
  let inspectedAccounts = 0
  let affectedAccounts = 0
  let lastId: UserId | undefined
  for (;;) {
    let rows: Array<{ id: UserId }>
    if (users.listVisibleIds) {
      const ids = await users.listVisibleIds(lastId, 500)
      rows = ids.map((id) => ({ id }))
    } else {
      const query = deps.db.from(table).select('id').orderBy('id', 'asc').limit(500)
      if (lastId !== undefined) query.where('id', '>', lastId)
      rows = await query
    }
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
    const loginMethodsByUserId = new Map<string, Set<string>>()
    for (const identity of identities) {
      if (!isSocialProviderName(identity.provider))
        throw new RuntimeException('Unknown confirmed provider in login inventory')
      const key = String(identity.user_id)
      const values = loginMethodsByUserId.get(key) ?? new Set<string>()
      values.add(identity.provider)
      loginMethodsByUserId.set(key, values)
    }
    for (const row of rows) {
      const id = row.id as UserId
      const user = await users.findById(id)
      if (!user) throw new RuntimeException('Account adapter could not resolve an inventoried user')
      if (typeof user.hasPassword !== 'boolean')
        throw new RuntimeException(
          'Account adapter must report whether each inventoried user has a password'
        )
      inspectedAccounts++
      const confirmed = loginMethodsByUserId.get(String(id)) ?? new Set<string>()
      const hadUsableMethod =
        (currentPasswordLogin && user.hasPassword) ||
        [...confirmed].some((provider) => currentProviders.has(provider as SocialProviderName))
      const retainsMethod =
        (input.passwordLogin && currentPasswordLogin && user.hasPassword) ||
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
    currentPasswordLogin,
  }
}
