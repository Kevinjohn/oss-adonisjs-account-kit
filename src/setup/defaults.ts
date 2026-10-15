import type { SetupChoices } from './types.js'

/** Reviewable starter selection; callers must still supply application-specific values. */
export function defaultSetupChoices(): SetupChoices {
  return {
    version: 1,
    mode: 'managed',
    features: [
      'registration',
      'authentication',
      'emailVerification',
      'passwordReset',
      'emailPasswordManagement',
    ],
    managed: [
      'registration',
      'authentication',
      'emailVerification',
      'passwordReset',
      'emailPasswordManagement',
    ],
    routePrefix: '/account',
    user: {
      model: '#models/user',
      table: 'users',
      idType: 'integer',
      adapter: 'lucid',
      connection: 'default',
      primaryKey: 'id',
      emailColumn: 'email',
      passwordColumn: 'password',
      verifiedColumn: 'email_verified_at',
    },
    authentication: {
      strategy: 'session',
      guard: 'web',
      session: { secureCookie: false, csrf: false, originChecked: false, persistentStore: false },
      applicationRouteRevocation: false,
    },
    mail: {
      integration: 'adonisjs-mail',
      delivery: 'best-effort',
      senderEnv: 'ACCOUNT_MAIL_FROM',
      transportEnv: 'MAIL_MAILER',
      appName: 'My application',
      backendOriginEnv: 'APP_URL',
      frontendOriginEnv: 'ACCOUNT_FRONTEND_URL',
      destinations: {
        emailVerification: 'account/verification',
        passwordReset: 'account/recovery',
        emailChange: 'account/email-change',
      },
      durableWorkerVerified: false,
    },
    policy: {
      registration: 'open',
      registrationFields: [],
      password: {
        minLength: 8,
        maxLength: null,
        letters: false,
        mixedCase: false,
        numbers: false,
        symbols: false,
        minScore: 0,
      },
      verificationRequired: true,
      unverifiedActions: ['logout', 'verificationResend', 'passwordReset'],
      invitationPermissionHook: false,
      accessRestrictionHook: false,
    },
    social: { status: 'not-applicable', reason: 'Social sign-in not selected' },
  }
}
