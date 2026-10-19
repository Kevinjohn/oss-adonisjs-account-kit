import type { SetupChoices, SetupInspection } from './types.js'
import { parseSetupChoices } from './parse.js'
import { hasEmailFlow, managedExclusions } from './shared.js'

export function managedRoutesSource(choices: SetupChoices): string {
  const social =
    choices.social.status === 'enabled' && choices.managed.includes('socialAuthentication')
      ? choices.social
      : null
  return [
    "import router from '@adonisjs/core/services/router'",
    "import app from '@adonisjs/core/services/app'",
    "import { AccountKit } from 'adonisjs-account-kit'",
    "import { registerManagedRoutes } from 'adonisjs-account-kit/http'",
    "import { accountKitGuard } from '#services/account_kit_guard'",
    '',
    'registerManagedRoutes(router, {',
    `  prefix: ${JSON.stringify(choices.routePrefix)},`,
    `  enabled: ${JSON.stringify(choices.managed)},`,
    ...('managedExcept' in choices || managedExclusions(choices).length
      ? [`  except: ${JSON.stringify(managedExclusions(choices))},`]
      : []),
    `  verificationRequired: ${choices.policy.verificationRequired},`,
    '  kit: () => app.container.make(AccountKit),',
    '  guard: accountKitGuard,',
    ...(social
      ? [`  extensions: { social: { providers: ${JSON.stringify(social.providers)} } },`]
      : []),
    '})',
    '',
  ].join('\n')
}

export function disabledManagedRoutesSource(previous: SetupChoices): string {
  return `// Account Kit managed endpoints are disabled by setup.\n// Previous generated selection: ${Buffer.from(JSON.stringify(previous)).toString('base64url')}\n`
}

export function selectedRouteSource(choices: SetupChoices): string {
  return choices.authentication?.applicationRouteRevocation
    ? managedRoutesSource(choices)
    : disabledManagedRoutesSource(choices)
}

export function retainedGeneratedChoices(state: SetupInspection): SetupChoices | null {
  const marker = state.files['start/account_kit_routes.ts']
  const encoded = marker?.match(
    /^\/\/ Account Kit managed endpoints are disabled by setup\.\n\/\/ Previous generated selection: ([A-Za-z0-9_-]+)\n$/
  )?.[1]
  if (!encoded) return null
  try {
    const previous = parseSetupChoices(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    )
    return marker === disabledManagedRoutesSource(previous) ? previous : null
  } catch {
    return null
  }
}

export function allyConfigSource(choices: SetupChoices): string {
  if (choices.social.status !== 'enabled') throw new Error('Social providers are not selected')
  const social = choices.social
  const origin = social.callbackOriginEnv
  return [
    "import { defineConfig, services } from '@adonisjs/ally'",
    "import type { InferSocialProviders } from '@adonisjs/ally/types'",
    '',
    'const requiredEnv = (name: string): string => {',
    '  const value = process.env[name]',
    '  if (!value) throw new Error(`account_kit: ${name} must be configured`)',
    '  return value',
    '}',
    '',
    'const allyConfig = defineConfig({',
    ...social.providers.map((provider) => {
      const refs = social.credentials[provider]!
      const path = social.callbackPath.replace('{provider}', provider)
      return [
        `  ${provider}: services.${provider}({`,
        `    clientId: requiredEnv(${JSON.stringify(refs.clientIdEnv)}),`,
        `    clientSecret: requiredEnv(${JSON.stringify(refs.clientSecretEnv)}),`,
        `    callbackUrl: new URL(${JSON.stringify(path)}, requiredEnv(${JSON.stringify(origin)})).toString(),`,
        ...(provider === 'github' ? ["    scopes: ['user:email'],"] : []),
        '  }),',
      ].join('\n')
    }),
    '})',
    '',
    "declare module '@adonisjs/ally/types' {",
    '  interface SocialProviders extends InferSocialProviders<typeof allyConfig> {}',
    '}',
    '',
    'export default allyConfig',
    '',
  ].join('\n')
}

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

export function accountConfigSource(choices: SetupChoices): string {
  const emailEnabled = hasEmailFlow(choices)
  const managedMail = emailEnabled && choices.mail.integration === 'adonisjs-mail'
  const social = choices.social.status === 'enabled' ? choices.social : null
  const serviceCapabilities = choices.features.filter((name) => name !== 'authentication')
  const usesPolicy =
    choices.policy.accessRestrictionHook || choices.features.includes('invitations')
  const imports = [
    "import env from '#start/env'",
    ...(emailEnabled ? ["import app from '@adonisjs/core/services/app'"] : []),
    `import { ${[
      ...(emailEnabled ? ['createActionUrls'] : []),
      'defineConfig',
      ...(choices.user.adapter === 'lucid' ? ['createLucidAdapter'] : []),
      ...(managedMail ? ['createMailNotifications'] : []),
      ...(social ? ['createAllySocialProvider'] : []),
    ].join(', ')} } from 'adonisjs-account-kit'`,
    ...(choices.user.adapter === 'custom'
      ? ["import users from '#services/account_kit_users'"]
      : []),
    ...(!emailEnabled || managedMail
      ? []
      : ["import { accountKitNotifications } from '#services/account_kit_notifications'"]),
    ...(usesPolicy ? ["import { accountKitPolicy } from '#services/account_kit_policy'"] : []),
    ...(choices.policy.registrationFields.length
      ? ["import { InvalidInputError } from 'adonisjs-account-kit/errors'"]
      : []),
    ...(social ? ["import type { HttpContext } from '@adonisjs/core/http'"] : []),
    '',
    ...(emailEnabled
      ? [
          'const requiredEnv = (name: string): string => {',
          '  const value = process.env[name]',
          '  if (!value) throw new Error(`account_kit: ${name} must be configured`)',
          '  return value',
          '}',
        ]
      : []),
    ...(choices.policy.registrationFields.length
      ? [
          '',
          `const registrationFields: ReadonlyArray<{ name: string; type: 'string' | 'number' | 'boolean'; required: boolean; maxLength?: number }> = ${JSON.stringify(choices.policy.registrationFields)}`,
          'const mapRegistrationFields = (input: unknown): Record<string, unknown> => {',
          "  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new InvalidInputError('account_kit: registrationData must be an object')",
          '  const source = (input ?? {}) as Record<string, unknown>',
          '  const output: Record<string, unknown> = {}',
          '  for (const key of Object.keys(source)) if (!registrationFields.some((field) => field.name === key)) throw new InvalidInputError(`account_kit: registrationData.${key} is not allowed`)',
          '  for (const field of registrationFields) {',
          '    const value = Object.prototype.hasOwnProperty.call(source, field.name) ? source[field.name] : undefined',
          '    if (value === undefined) {',
          '      if (field.required) throw new InvalidInputError(`account_kit: registrationData.${field.name} is required`)',
          '      continue',
          '    }',
          '    if (typeof value !== field.type) throw new InvalidInputError(`account_kit: registrationData.${field.name} must be ${field.type}`)',
          "    const mapped = field.required && typeof value === 'string' ? value.trim() : value",
          "    if (field.required && mapped === '') throw new InvalidInputError(`account_kit: registrationData.${field.name} is required`)",
          "    if (field.type === 'string' && typeof mapped === 'string' && field.maxLength !== undefined && mapped.length > field.maxLength) throw new InvalidInputError(`account_kit: registrationData.${field.name} is too long`)",
          '    output[field.name] = mapped',
          '  }',
          '  return output',
          '}',
        ]
      : []),
    ...(choices.user.adapter === 'lucid'
      ? choices.policy.registrationFields.length
        ? [
            `const users = createLucidAdapter(async () => (await import(${JSON.stringify(choices.user.model)})).default, {`,
            '  mapRegistrationData: (data, user) => {',
            '    const fields = mapRegistrationFields(data)',
            '    for (const field of registrationFields) {',
            '      if (Object.prototype.hasOwnProperty.call(fields, field.name)) (user as unknown as Record<string, unknown>)[field.name] = fields[field.name]',
            '    }',
            '  },',
            '})',
          ]
        : [
            `const users = createLucidAdapter(async () => (await import(${JSON.stringify(choices.user.model)})).default)`,
          ]
      : []),
    '',
    'export default defineConfig({',
    '  users,',
    ...(choices.user.adapter === 'custom'
      ? [`  usersTable: ${JSON.stringify(choices.user.table)},`]
      : []),
    `  enabled: ${JSON.stringify(serviceCapabilities)},`,
    `  registration: { availability: ${JSON.stringify(choices.policy.registration)}${choices.policy.registrationFields.length ? ', mapFields: mapRegistrationFields' : ''} },`,
    `  passwordPolicy: ${JSON.stringify(choices.policy.password)},`,
    ...(emailEnabled ? [`  delivery: ${JSON.stringify(choices.mail.delivery)},`] : []),
    "  limiterSecret: env.get('APP_KEY').release(),",
    ...(choices.authentication
      ? [
          '  authentication: {',
          `    strategy: ${JSON.stringify(choices.authentication.strategy)},`,
          `    guard: ${JSON.stringify(choices.authentication.guard)},`,
          ...(choices.authentication.strategy === 'access_tokens' && choices.authentication.token
            ? [
                `    tokenExpiresIn: ${JSON.stringify(choices.authentication.token.lifetime)},`,
                `    tokenAbilities: ${JSON.stringify(choices.authentication.token.abilities)},`,
              ]
            : []),
          ...(choices.policy.accessRestrictionHook
            ? ['    canAccess: accountKitPolicy.canAccess,']
            : []),
          '  },',
        ]
      : []),
    ...(social
      ? [
          '  socialAuthentication: {',
          '    providers: {',
          ...social.providers.flatMap((provider) => [
            `      ${provider}: createAllySocialProvider({`,
            `        authorizationUrl: (state, context) => (context as HttpContext).ally.use('${provider}').stateless().redirectUrl((request) => request.param('state', state)),`,
            `        user: (callback) => (callback as HttpContext).ally.use('${provider}').stateless().user(),`,
            '      }),',
          ]),
          '    },',
          '  },',
        ]
      : []),
    ...(emailEnabled
      ? [
          '  urls: createActionUrls({',
          `    backendOrigin: requiredEnv(${JSON.stringify(choices.mail.backendOriginEnv)}),`,
          `    appFrontendUrl: requiredEnv(${JSON.stringify(choices.mail.frontendOriginEnv)}),`,
          "    environment: app.inProduction ? 'production' : app.inTest ? 'test' : 'development',",
          `    destinations: ${JSON.stringify(choices.mail.destinations)},`,
          '  }),',
        ]
      : ['  urls: {},']),
    ...(!emailEnabled
      ? ['  notify: {},']
      : managedMail
        ? [
            '  notify: createMailNotifications({',
            "    mail: { sendLater: async (render) => (await import('@adonisjs/mail/services/main')).default.sendLater(render) },",
            `    from: requiredEnv(${JSON.stringify(choices.mail.senderEnv)}),`,
            `    brandName: ${JSON.stringify(choices.mail.appName)},`,
            '  }),',
          ]
        : ['  notify: accountKitNotifications,']),
    ...(choices.features.includes('invitations')
      ? [
          '  authorize: accountKitPolicy.authorize,',
          '  onInvitationAccepted: accountKitPolicy.onInvitationAccepted,',
        ]
      : []),
    '})',
    '',
  ]
  return imports.join('\n')
}

export function generatedEnv(choices: SetupChoices): string {
  const names = new Set<string>()
  if (hasEmailFlow(choices)) {
    names.add(choices.mail.backendOriginEnv)
    names.add(choices.mail.frontendOriginEnv)
    if (choices.mail.senderEnv) names.add(choices.mail.senderEnv)
    if (choices.mail.transportEnv) names.add(choices.mail.transportEnv)
  }
  if (choices.social.status === 'enabled') {
    names.add(choices.social.callbackOriginEnv)
    for (const provider of choices.social.providers) {
      const refs = choices.social.credentials[provider]
      if (refs) {
        names.add(refs.clientIdEnv)
        names.add(refs.clientSecretEnv)
      }
    }
  }
  return [
    '# Account Kit deployment values; supply real values through your deployment environment',
    ...[...names].sort().map((name) => `${name}=`),
    '',
  ].join('\n')
}
