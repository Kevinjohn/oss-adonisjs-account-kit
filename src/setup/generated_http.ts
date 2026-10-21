import type { SetupChoices } from './types.js'
import { managedExclusions } from './shared.js'

export function managedGuardSource(choices: SetupChoices): string {
  const auth = choices.authentication!
  return [
    "import { createManagedGuard } from 'adonisjs-account-kit/http'",
    '',
    'export const accountKitGuard = createManagedGuard({',
    `  strategy: ${JSON.stringify(auth.strategy)},`,
    `  name: ${JSON.stringify(auth.guard)},`,
    `  loadUser: () => import(${JSON.stringify(choices.user.model)}).then((module) => module.default),`,
    '})',
    '',
  ].join('\n')
}

export function managedAccessMiddlewareSource(choices: SetupChoices): string {
  return [
    "import type { HttpContext } from '@adonisjs/core/http'",
    "import app from '@adonisjs/core/services/app'",
    "import { AccountKit } from 'adonisjs-account-kit'",
    "import { managedAccountMiddleware } from 'adonisjs-account-kit/http'",
    "import { accountKitGuard } from '#services/account_kit_guard'",
    '',
    'const checkAccess = managedAccountMiddleware({',
    '  kit: () => app.container.make(AccountKit),',
    '  guard: accountKitGuard,',
    `  active: ${choices.policy.verificationRequired},`,
    '})',
    '',
    'export default class AccountKitAccessMiddleware {',
    '  handle(ctx: HttpContext, next: () => Promise<unknown>): Promise<unknown> {',
    '    return checkAccess(ctx, next)',
    '  }',
    '}',
    '',
  ].join('\n')
}

export function proofHeadersMiddlewareSource(choices: SetupChoices): string {
  return [
    "import type { HttpContext } from '@adonisjs/core/http'",
    "import { managedProofHeadersMiddleware } from 'adonisjs-account-kit/http'",
    '',
    'const applyProofHeaders = managedProofHeadersMiddleware({',
    `  prefix: ${JSON.stringify(choices.routePrefix)},`,
    `  strategy: ${JSON.stringify(choices.authentication?.strategy ?? 'session')},`,
    `  enabled: ${JSON.stringify(choices.managed)},`,
    `  except: ${JSON.stringify(managedExclusions(choices))},`,
    '})',
    '',
    'export default class AccountKitProofHeadersMiddleware {',
    '  handle(ctx: HttpContext, next: () => Promise<unknown>): Promise<unknown> {',
    '    return applyProofHeaders(ctx, next)',
    '  }',
    '}',
    '',
  ].join('\n')
}
