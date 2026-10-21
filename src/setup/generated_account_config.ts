import type { SetupChoices } from './types.js'
import { hasEmailFlow } from './shared.js'
import { requiredEnvHelperLines } from './generated_env_helpers.js'

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
    ...(emailEnabled ? requiredEnvHelperLines : []),
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
    "  limiterSecret: env.get('APP_KEY'),",
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
