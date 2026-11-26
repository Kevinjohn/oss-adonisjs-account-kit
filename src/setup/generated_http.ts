import type { SetupChoices } from './types.ts'
import { listManagedExclusions } from './shared.ts'

export function generateManagedGuardSource(choices: SetupChoices): string {
  const auth = choices.authentication!
  return [
    "import { createManagedGuard } from '@kevinjohn/adonisjs-account-kit/http'",
    '',
    'export const accountKitGuard = createManagedGuard({',
    `  strategy: ${JSON.stringify(auth.strategy)},`,
    `  name: ${JSON.stringify(auth.guard)},`,
    `  loadUser: () => import(${JSON.stringify(choices.user.model)}).then((module) => module.default),`,
    '})',
    '',
  ].join('\n')
}

export function generateAccessMiddlewareSource(choices: SetupChoices): string {
  return [
    "import type { HttpContext } from '@adonisjs/core/http'",
    "import app from '@adonisjs/core/services/app'",
    "import { AccountKit } from '@kevinjohn/adonisjs-account-kit'",
    "import ManagedAccountMiddleware from '@kevinjohn/adonisjs-account-kit/middleware/managed_account'",
    "import { accountKitGuard } from '#services/account_kit_guard'",
    '',
    'const checkAccess = new ManagedAccountMiddleware({',
    '  kit: () => app.container.make(AccountKit),',
    '  guard: accountKitGuard,',
    `  active: ${choices.policy.verificationRequired},`,
    '})',
    '',
    'export default class AccountKitAccessMiddleware {',
    '  handle(ctx: HttpContext, next: () => Promise<unknown>): Promise<unknown> {',
    '    return checkAccess.handle(ctx, next)',
    '  }',
    '}',
    '',
  ].join('\n')
}

export function generateProofHeadersMiddlewareSource(choices: SetupChoices): string {
  return [
    "import type { HttpContext } from '@adonisjs/core/http'",
    "import ManagedProofHeadersMiddleware from '@kevinjohn/adonisjs-account-kit/middleware/proof_headers'",
    '',
    'const applyProofHeaders = new ManagedProofHeadersMiddleware({',
    `  prefix: ${JSON.stringify(choices.routePrefix)},`,
    `  strategy: ${JSON.stringify(choices.authentication?.strategy ?? 'session')},`,
    `  enabled: ${JSON.stringify(choices.managed)},`,
    `  except: ${JSON.stringify(listManagedExclusions(choices))},`,
    '})',
    '',
    'export default class AccountKitProofHeadersMiddleware {',
    '  handle(ctx: HttpContext, next: () => Promise<unknown>): Promise<unknown> {',
    '    return applyProofHeaders.handle(ctx, next)',
    '  }',
    '}',
    '',
  ].join('\n')
}
