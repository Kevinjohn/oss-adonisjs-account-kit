// Fresh install: configure the reference app from the packed archive and run its suites.
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { format, resolveConfig } from 'prettier'
import {
  adaptGeneratedUserSchema,
  configure,
  databaseEnvironment,
  installArchive,
  packageMigrations,
} from './consumer_app.mjs'
import { digest, expectFailure, hashFiles, run } from './harness.mjs'
import { resetExclusivePostgresSchema } from './postgres.mjs'
import { fixtureRoot, prepareOnly, tempRoot, userIdType, usersTable } from './settings.mjs'

/** Checks the generated config as written, before the app's formatter can repair it. */
async function checkGeneratedStyle(appRoot, env) {
  const configPath = join(appRoot, 'config/account_kit.ts')
  // The AdonisJS stub engine trims every file it renders, so the final newline is not ours.
  const generated = await readFile(configPath, 'utf8')
  const written = generated + '\n'
  const options = await resolveConfig(configPath)
  if ((await format(written, { ...options, filepath: configPath })) !== written)
    throw new Error('The generated config/account_kit.ts is not formatted')
  await writeFile(configPath, written)
  try {
    run('pnpm', ['exec', 'eslint', '--max-warnings', '0', 'config/account_kit.ts'], appRoot, env)
  } finally {
    await writeFile(configPath, generated)
  }
}

export async function runFresh(candidate, runName) {
  const appRoot = join(tempRoot, runName)
  await cp(fixtureRoot, appRoot, {
    recursive: true,
    filter: (path) => !path.includes('/node_modules/'),
  })
  await mkdir(join(appRoot, 'tmp'), { recursive: true })
  const env = {
    ...databaseEnvironment(appRoot),
    ACCOUNT_KIT_USERS_TABLE: usersTable,
    ACCOUNT_KIT_USER_ID_TYPE: userIdType,
  }
  const adapterPath = join(tempRoot, `${runName}-adapter.ts`)
  const configPath = join(appRoot, 'config/account_kit.ts')
  const adonisrcPath = join(appRoot, 'adonisrc.ts')
  await copyFile(configPath, adapterPath)
  await rm(configPath)
  for (const migration of await packageMigrations(appRoot)) await rm(migration)
  const originalRc = await readFile(adonisrcPath, 'utf8')
  const withoutProvider = originalRc.replace(
    /^\s*\(\) => import\(['"]adonisjs-account-kit\/account_kit_provider['"]\),?\r?\n/m,
    ''
  )
  if (withoutProvider === originalRc)
    throw new Error('Fresh fixture did not contain a removable provider entry')
  await writeFile(adonisrcPath, withoutProvider)

  const installed = await installArchive(appRoot, candidate)
  await resetExclusivePostgresSchema(appRoot)
  await configure(appRoot, env)
  await checkGeneratedStyle(appRoot, env)
  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  await adaptGeneratedUserSchema(appRoot)
  run('pnpm', ['run', 'typecheck'], appRoot, env)
  const generatedConfigSha256 = await digest(configPath)
  const configuredRc = await readFile(adonisrcPath, 'utf8')
  if ((configuredRc.match(/adonisjs-account-kit\/account_kit_provider/g) ?? []).length !== 1) {
    throw new Error('Configure did not register exactly one account-kit provider')
  }
  await copyFile(adapterPath, configPath)

  const beforeConfig = await digest(configPath)
  const beforeRc = await digest(adonisrcPath)
  const beforeMigrations = await hashFiles(await packageMigrations(appRoot))
  const allMigrationFiles = await readdir(join(appRoot, 'database/migrations'))
  await configure(appRoot, env)
  if ((await digest(configPath)) !== beforeConfig)
    throw new Error('Reconfigure replaced the app-owned config')
  if ((await digest(adonisrcPath)) !== beforeRc)
    throw new Error('Reconfigure changed provider registration')
  if (
    JSON.stringify(await hashFiles(await packageMigrations(appRoot))) !==
    JSON.stringify(beforeMigrations)
  ) {
    throw new Error('Reconfigure changed an existing package migration')
  }
  if (
    JSON.stringify(await readdir(join(appRoot, 'database/migrations'))) !==
    JSON.stringify(allMigrationFiles)
  ) {
    throw new Error('Reconfigure changed the migration file set')
  }

  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  await adaptGeneratedUserSchema(appRoot)
  run('pnpm', ['run', 'migrate'], appRoot, env)
  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  await adaptGeneratedUserSchema(appRoot)
  run('pnpm', ['run', 'format'], appRoot, env)
  run('pnpm', ['run', 'typecheck'], appRoot, env)
  run('pnpm', ['run', 'lint'], appRoot, env)
  run('pnpm', ['run', 'format:check'], appRoot, env)
  if (!prepareOnly) {
    run('pnpm', ['run', 'test'], appRoot, { ...env, ACCOUNT_KIT_AUTH_STRATEGY: 'access_tokens' })
    run('pnpm', ['run', 'test:session'], appRoot, {
      ...env,
      ACCOUNT_KIT_AUTH_STRATEGY: 'session',
      SESSION_DRIVER: 'memory',
    })
    run(
      'pnpm',
      ['exec', 'node', 'ace', 'test', '--files=tests/functional/release_scenarios.spec.ts'],
      appRoot,
      { ...env, ACCOUNT_KIT_AUTH_STRATEGY: 'session', SESSION_DRIVER: 'memory' }
    )
    expectFailure(
      'pnpm',
      ['run', 'test:session'],
      appRoot,
      { ...env, ACCOUNT_KIT_AUTH_STRATEGY: 'session', SESSION_DRIVER: 'cookie' },
      'session authentication requires a server-side session store'
    )
  }
  return {
    appRoot,
    installed,
    generatedConfigSha256,
    configSha256: beforeConfig,
    migrations: beforeMigrations.length,
  }
}
