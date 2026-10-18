import type { ExistingRoute, ManagedEndpointName } from '../http/routes.js'
import type { SocialProviderName } from '../types.js'

export const featureNames = [
  'registration',
  'authentication',
  'emailVerification',
  'passwordReset',
  'emailPasswordManagement',
  'invitations',
  'socialAuthentication',
  'magicLinkLogin',
  'sessionManagement',
  'dataExport',
  'accountDeletion',
] as const

export type SetupFeature = (typeof featureNames)[number]
export type GuardStrategy = 'session' | 'access_tokens'

/** Values here are application choices. Deployment values remain environment references. */
export interface SetupChoices {
  version: 1
  mode: 'services' | 'managed'
  features: SetupFeature[]
  managed: SetupFeature[]
  managedExcept?: ManagedEndpointName[]
  routePrefix: string
  user: {
    model: string
    table: string
    idType: 'integer' | 'string' | 'uuid'
    adapter: 'lucid' | 'custom'
    connection: 'default'
    primaryKey: 'id'
    emailColumn: 'email'
    passwordColumn: 'password'
    verifiedColumn: 'email_verified_at'
  }
  authentication: {
    strategy: GuardStrategy
    guard: string
    /** A session needs explicit cookie, CSRF, origin, and storage checks. */
    session?: {
      secureCookie: boolean
      csrf: boolean
      originChecked: boolean
      persistentStore: boolean
    }
    token?: { revocation: boolean; lifetime: string; abilities: string[] }
    applicationRouteRevocation: boolean
  } | null
  mail: {
    integration: 'adonisjs-mail' | 'custom'
    delivery: 'best-effort' | 'durable'
    senderEnv: string | null
    transportEnv: string | null
    appName: string
    backendOriginEnv: string
    frontendOriginEnv: string
    destinations: Partial<
      Record<
        'emailVerification' | 'passwordReset' | 'invitation' | 'emailChange' | 'magicLink',
        string
      >
    >
    durableWorkerVerified: boolean
  }
  policy: {
    registration: 'open' | 'closed' | 'application'
    registrationFields: Array<{
      name: string
      type: 'string' | 'number' | 'boolean'
      required: boolean
      maxLength?: number
    }>
    password: {
      minLength: number
      maxLength: number | null
      letters: boolean
      mixedCase: boolean
      numbers: boolean
      symbols: boolean
      minScore: number
    }
    verificationRequired: boolean
    unverifiedActions: Array<'logout' | 'verificationResend' | 'passwordReset'>
    invitationPermissionHook: boolean
    accessRestrictionHook: boolean
  }
  social:
    | { status: 'not-applicable'; reason: string }
    | {
        status: 'enabled'
        providers: SocialProviderName[]
        callbackOriginEnv: string
        /** Absolute path with a {provider} placeholder; token clients own this destination. */
        callbackPath: string
        credentials: Partial<
          Record<SocialProviderName, { clientIdEnv: string; clientSecretEnv: string }>
        >
      }
}

export interface SetupInspection {
  root: string
  existingInstallation: boolean
  files: Record<string, string>
  guards: string[]
  guardStrategies: Record<string, GuardStrategy>
  guardModels: Record<string, string>
  guardTokenProviders: Record<string, string>
  installedVersions: Record<string, string>
  database: 'sqlite' | 'postgres' | 'unsupported' | 'unknown'
  connection: 'default' | 'unsupported' | 'unknown'
  installedPackages: string[]
  migrationNames: string[]
  existingPrefix: string | null
  routePaths: string[]
  routeDefinitions: ExistingRoute[]
  existingChoices: SetupChoices | null
}

export interface SetupDiagnostic {
  field: string
  message: string
  severity: 'error' | 'warning' | 'action'
}

export interface SetupFileChange {
  path: string
  action: 'create' | 'update' | 'unchanged' | 'conflict'
  content: string
  expected?: string
  reason: string
}

export interface SetupPlan {
  choices: SetupChoices
  preview: boolean
  changes: SetupFileChange[]
  diagnostics: SetupDiagnostic[]
  differences: string[]
  retirementImpact: {
    inspectedAccounts: number
    affectedAccounts: number
    checkedAt: string
    /** Booted login methods observed by the inventory, independent of persisted setup choices. */
    currentProviders?: SocialProviderName[]
    currentPasswordLogin?: boolean
  } | null
  prerequisites: string[]
  endpoints: string[]
  endpointLocations: Array<{ name: string; method: string; path: string }>
  migrationState: 'not-generated' | 'generated-application-unknown' | 'partially-generated'
  readiness: {
    configurationGenerated: boolean
    configurationValid: boolean
    migrationsApplied: false
    externalConfigured: boolean
    workflowVerified: false
    productionReady: false
    delivery: 'best effort' | 'durable' | 'not applicable'
  }
  pillars: Record<'features' | 'user' | 'authentication' | 'mail' | 'social' | 'policy', string>
}
