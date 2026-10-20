import type { HttpContext } from '@adonisjs/core/http'
import User from '#models/user'

type AccessCredential = {
  userId: number | string
  identifier: number | string | BigInt
  value: string
}

/** The same selected guard adapters serve both login and newly registered accounts. */
export function accessTokenGuard() {
  return {
    strategy: 'access_tokens' as const,
    name: 'api',
    async establish(
      userId: number | string,
      abilities: string[],
      expiresIn: string | number | null
    ) {
      const user = await User.findOrFail(userId)
      const token = await User.accessTokens.create(
        user,
        abilities,
        expiresIn === null ? undefined : { expiresIn }
      )
      return { userId, identifier: token.identifier, value: token.value!.release() }
    },
    async terminate(credential?: AccessCredential) {
      if (!credential) return
      const user = await User.findOrFail(credential.userId)
      await User.accessTokens.delete(user, credential.identifier)
    },
  }
}

export function accountKitSessionGuard(ctx: HttpContext) {
  const guard = ctx.auth.use('web')
  return {
    strategy: 'session' as const,
    name: 'web',
    async establish(userId: number | string, revision: string | null) {
      ctx.session.regenerate()
      await guard.login(await User.findOrFail(userId))
      ctx.session.put('accountKitRevision', revision ?? '')
      return undefined
    },
    async terminate() {
      await guard.logout()
      ctx.session.clear()
      ctx.session.regenerate()
    },
  }
}
