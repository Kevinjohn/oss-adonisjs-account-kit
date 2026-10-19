import type { Database } from '@adonisjs/lucid/database'
import { userMetadata } from './db.js'
import type { Capability, ResolvedConfig } from './types.js'

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
  fix?: string
}

export interface DoctorInput {
  config: ResolvedConfig | undefined
  db: Database
  limiterBound: boolean
  appUrl: string | undefined
  environment: 'development' | 'test' | 'production'
}

// Each proof flow clears the other kind of recovery token, so each needs both tables.
const capabilityTables: Record<Capability, string[]> = {
  passwordReset: ['password_reset_tokens', 'email_verification_tokens'],
  emailVerification: ['email_verification_tokens', 'password_reset_tokens'],
  registration: ['email_verification_tokens', 'password_reset_tokens'],
  emailPasswordManagement: ['email_verification_tokens', 'password_reset_tokens'],
  invitations: ['account_invitations'],
  dataExport: [],
  accountDeletion: [],
  socialAuthentication: [
    'social_identities',
    'social_transactions',
    'social_sensitive_proofs',
    'social_handoff_codes',
  ],
  magicLinkLogin: ['login_link_tokens'],
  sessionManagement: ['account_sessions'],
}

const migrationFix = 'Run `node ace configure adonisjs-account-kit`, then `node ace migration:run`'

function appUrlCheck(appUrl: string | undefined, environment: DoctorInput['environment']) {
  const name = 'APP_URL'
  if (!appUrl)
    return { name, ok: false, detail: 'is not set', fix: 'Set APP_URL to the public base URL' }
  let url: URL
  try {
    url = new URL(appUrl)
  } catch {
    return { name, ok: false, detail: 'is not an absolute URL', fix: 'Use https://example.com' }
  }
  if (!['http:', 'https:'].includes(url.protocol))
    return {
      name,
      ok: false,
      detail: 'must start with http:// or https://',
      fix: 'Use https://example.com',
    }
  if (environment === 'production' && url.protocol !== 'https:')
    return { name, ok: false, detail: 'must use HTTPS in production', fix: 'Use an https:// URL' }
  return { name, ok: true, detail: url.origin }
}

async function tableChecks(db: Database, config: ResolvedConfig): Promise<DoctorCheck[]> {
  const required = new Set(config.enabled.flatMap((capability) => capabilityTables[capability]))
  if (db.connection().dialect.name === 'better-sqlite3') required.add('account_transaction_lock')
  // Every credential change clears sign-in links, whether or not magic links are enabled.
  required.add('login_link_tokens')
  // Every credential change clears the sign-in registry, whether or not it is enabled.
  if (config.authentication) required.add('account_sessions')
  const missing: string[] = []
  for (const table of required)
    if (!(await db.connection().schema.hasTable(table))) missing.push(table)
  if (missing.length)
    return [
      {
        name: 'Package tables',
        ok: false,
        detail: `missing ${missing.join(', ')}`,
        fix: migrationFix,
      },
    ]
  return [{ name: 'Package tables', ok: true, detail: `${required.size} present` }]
}

async function usersCheck(db: Database, config: ResolvedConfig): Promise<DoctorCheck> {
  const name = 'Users table'
  let table: string
  try {
    const metadata = await userMetadata(config)
    table = metadata.table
  } catch (error) {
    return { name, ok: false, detail: (error as Error).message }
  }
  if (!(await db.connection().schema.hasTable(table)))
    return { name, ok: false, detail: `table ${table} does not exist`, fix: migrationFix }
  const columns = ['email', 'password', 'unverified_email', 'email_verified_at']
  if (config.authentication) columns.push('credentials_changed_at')
  const missing: string[] = []
  for (const column of columns)
    if (!(await db.connection().schema.hasColumn(table, column))) missing.push(column)
  if (missing.length)
    return {
      name,
      ok: false,
      detail: `${table} is missing ${missing.join(', ')}`,
      fix: migrationFix,
    }
  return { name, ok: true, detail: `${table} has the required columns` }
}

/** Read-only installation checks; each failure names the step that fixes it. */
export async function runDoctor(input: DoctorInput): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  if (!input.config) {
    checks.push({
      name: 'Config',
      ok: false,
      detail: 'config/account_kit.ts is missing or does not export defineConfig(...)',
      fix: 'Run `node ace configure adonisjs-account-kit`',
    })
  } else {
    checks.push({ name: 'Config', ok: true, detail: `enabled: ${input.config.enabled.join(', ')}` })
  }
  checks.push(
    input.limiterBound
      ? { name: 'Limiter', ok: true, detail: '@adonisjs/limiter is registered' }
      : {
          name: 'Limiter',
          ok: false,
          detail: '@adonisjs/limiter is not registered',
          fix: 'Run `node ace add @adonisjs/limiter`',
        }
  )
  checks.push(appUrlCheck(input.appUrl, input.environment))
  if (input.config) {
    checks.push(...(await tableChecks(input.db, input.config)))
    checks.push(await usersCheck(input.db, input.config))
  }
  return checks
}
