#!/usr/bin/env node
// Run a committed recipe against the pinned official starter, retaining reproducible evidence.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const option = (name, fallback) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const recipe = option('recipe')
const database = option('database', 'sqlite')
const candidateInput = option('candidate-tarball', process.env.CANDIDATE_TARBALL)
const candidateRevision = option('candidate-revision', process.env.CANDIDATE_REVISION)
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node 24 is required')
const apiRecipes = new Set(['api-password-reset', 'invitations-existing-app'])
if (!apiRecipes.has(recipe)) throw new Error(`Unknown recipe: ${recipe}`)
if (database !== 'sqlite') throw new Error('This recipe currently supports --database=sqlite only')
if (Boolean(candidateInput) !== Boolean(candidateRevision)) {
  throw new Error('--candidate-tarball and --candidate-revision must be supplied together')
}
const patch = join(root, 'docs/recipes/patches', `${recipe}.patch`)
const spec = join(root, 'examples/api/tests/recipes', `${recipe}.spec.ts`)
// Validate the committed inputs before downloading or creating anything.
let patchText
try {
  patchText = await readFile(patch, 'utf8')
  await readFile(spec)
} catch (error) {
  if (error.code === 'ENOENT')
    throw new Error(
      `Recipe ${recipe} is unavailable in this checkout: missing patch or acceptance spec`
    )
  throw error
}
for (const entry of patchText.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
  if (
    /^(?:node_modules\/|build\/|\.adonisjs\/|vendor\/|database\/schema\.ts$)/.test(entry[2]) ||
    /^database\/migrations\/.*_account_kit_/.test(entry[2]) ||
    /\.(?:tgz|tar(?:\.gz)?)$/.test(entry[2]) ||
    /(?:^|\/)(?:pnpm-lock\.yaml|package\.json)$/.test(entry[2])
  ) {
    throw new Error(`Recipe patch contains a generated or dependency file: ${entry[2]}`)
  }
}
const retained = await mkdtemp(join(tmpdir(), 'account-kit-recipe-'))
const appRoot = join(retained, 'app')
const specCommand = ['test', `--files=${recipe}.spec.ts`]
const evidence = {
  recipe,
  database,
  runtime: process.versions.node,
  starterRevision: '46d235932e3eb6472a16b740fa0b47b5f69fc6fc',
  scaffolderVersion: '3.4.0',
  notificationMode: 'local in-process callback capture',
  commands: [],
  status: 'running',
  retainedScaffold: appRoot,
  specCommand: `pnpm ${specCommand.join(' ')}`,
}
const listener = createServer()
try {
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
} catch (error) {
  evidence.status = 'failed'
  evidence.error = error.stack ?? String(error)
  await writeFile(join(retained, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`Evidence: ${join(retained, 'evidence.json')}`)
  console.log(`Retained scaffold: ${appRoot}`)
  throw error
}
const port = String(listener.address().port)
await new Promise((resolve) => listener.close(resolve))
// Only runtime, OS and explicitly supported package-cache settings reach child processes.
function childEnvironment(source) {
  const runtimeNames = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'CI',
    'NO_COLOR',
    'FORCE_COLOR',
    'PNPM_HOME',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ])
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        runtimeNames.has(name) ||
        /^pnpm_config_(?:offline|store_dir|cache_dir|verify_deps_before_run|enable_global_virtual_store)$/i.test(
          name
        )
    )
  )
}
const inheritedEnv = childEnvironment(process.env)
const testEnvironment = {
  NODE_ENV: 'test',
  TZ: 'UTC',
  HOST: '127.0.0.1',
  PORT: port,
  LOG_LEVEL: 'silent',
  APP_URL: `http://127.0.0.1:${port}`,
  APP_KEY: randomBytes(32).toString('hex'),
  SESSION_DRIVER: 'memory',
  LIMITER_STORE: 'memory',
  DB_CONNECTION: 'sqlite',
  PATH: process.env.PATH,
  pnpm_config_enable_global_virtual_store: 'false',
}
const env = { ...inheritedEnv, ...testEnvironment }
const rerunPath = join(retained, 'rerun.mjs')
await writeFile(join(retained, 'test-environment.json'), JSON.stringify(testEnvironment), {
  mode: 0o600,
})
await writeFile(
  rerunPath,
  `import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
${childEnvironment.toString()}
const inherited = childEnvironment(process.env)
const settings = JSON.parse(readFileSync(new URL('./test-environment.json', import.meta.url), 'utf8'))
const result = spawnSync('pnpm', ${JSON.stringify(specCommand)}, { cwd: ${JSON.stringify(appRoot)}, env: { ...inherited, ...settings }, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
`
)
evidence.specCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(rerunPath)}`
function run(command, args, cwd = appRoot) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  evidence.commands.push({
    command,
    args,
    cwd,
    exitCode: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message ?? `${command} failed: ${result.stderr}\n${result.stdout}`
    )
  return result.stdout
}
const digest = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

try {
  evidence.sourceRevision = run('git', ['rev-parse', 'HEAD'], root).trim()
  evidence.sourceChanges = run('git', ['status', '--short'], root).trim()
  evidence.packageManager = run('pnpm', ['--version'], root).trim()
  let candidate = candidateInput && resolve(candidateInput)
  if (!candidate) {
    run('pnpm', ['--config.verify-deps-before-run=false', 'build'], root)
    const destination = join(retained, 'candidate')
    await mkdir(destination)
    run(
      'pnpm',
      ['--config.verify-deps-before-run=false', 'pack', '--pack-destination', destination],
      root
    )
    const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
    if (archives.length !== 1) throw new Error('Expected exactly one development archive')
    candidate = join(destination, archives[0])
  }
  evidence.candidateRevision = candidateRevision ?? evidence.sourceRevision
  evidence.candidateTarball = candidate
  evidence.candidateSha256 = await digest(candidate)
  run(
    'pnpm',
    [
      'create',
      'adonisjs@3.4.0',
      appRoot,
      `--kit=github:adonisjs/starter-kits/api#${evidence.starterRevision}`,
      '--pkg=pnpm',
    ],
    retained
  )
  // The pinned creator leaves repository initialisation to the application owner.
  run('git', ['init'])
  evidence.baselineInitialization = 'manual git init after pinned starter creation'
  run('git', ['add', '-A'])
  run('git', ['commit', '-m', 'starter'])
  evidence.starterCommit = run('git', ['rev-parse', 'HEAD']).trim()
  evidence.starterDependencies = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  evidence.starterLockSha256 = await digest(join(appRoot, 'pnpm-lock.yaml'))
  // This pinned starter hardcodes SQLite and app.tmpPath('db.sqlite3'); reject drift
  // before invoking migrations rather than trusting database environment aliases.
  const databaseConfig = await readFile(join(appRoot, 'config/database.ts'), 'utf8')
  if (
    !/connection:\s*'sqlite'/.test(databaseConfig) ||
    !/filename:\s*app\.tmpPath\('db\.sqlite3'\)/.test(databaseConfig)
  ) {
    throw new Error("Pinned API starter must use SQLite at app.tmpPath('db.sqlite3')")
  }
  evidence.databasePath = join(appRoot, 'tmp/db.sqlite3')

  // P1 proves the application's original login before Account Kit is installed.
  run('pnpm', ['exec', 'node', 'ace', 'migration:run', '--force'])
  const baselineSpec = join(appRoot, 'tests/functional/recipe_starter_login.spec.ts')
  await mkdir(dirname(baselineSpec), { recursive: true })
  await writeFile(
    baselineSpec,
    `import { test } from '@japa/runner'
import User from '#models/user'
test('original starter login reaches its protected profile', async ({ client, assert }) => {
  const user = await User.create({ fullName: 'Starter Owner', email: 'starter@example.test', password: 'OriginalPass123!' })
  const login = await client.post('/api/v1/auth/login').json({ email: user.email, password: 'OriginalPass123!' })
  assert.equal(login.status(), 200)
  const token = login.body().data.token
  assert.isString(token)
  const profile = await client.get('/api/v1/account/profile').bearerToken(token)
  assert.equal(profile.status(), 200)
})
`
  )
  run('pnpm', ['test', '--files=recipe_starter_login.spec.ts'])
  await rm(baselineSpec)
  run('pnpm', ['add', candidate, '@adonisjs/limiter@^3.0.0'])
  // Limiter's configurator supports database/redis; tests select its runtime memory store.
  run('pnpm', ['exec', 'node', 'ace', 'configure', '@adonisjs/limiter', '--store=database'])
  run('pnpm', ['exec', 'node', 'ace', 'configure', 'adonisjs-account-kit'])
  evidence.generatedInventory = run('git', ['status', '--porcelain'])
  run('git', ['add', '-A'])
  run('git', ['commit', '-m', 'Configure account dependencies'])
  evidence.patchBaseline = run('git', ['rev-parse', 'HEAD']).trim()
  run('git', ['apply', '--check', patch])
  run('git', ['apply', patch])
  await copyFile(spec, join(appRoot, 'tests/functional', `${recipe}.spec.ts`))
  run('pnpm', ['add', '-D', '@japa/api-client@^3.2.1'])
  run('pnpm', ['exec', 'node', 'ace', 'migration:run', '--force'])
  const routes = run('pnpm', ['exec', 'node', 'ace', 'list:routes'])
  evidence.routes = routes
  if (recipe === 'api-password-reset') {
    const mounted = routes.split('\n').filter((line) => line.includes('/account-kit/'))
    if (
      mounted.length !== 3 ||
      mounted.some((line) => !line.includes('/account-kit/auth/password-reset'))
    ) {
      throw new Error('Expected only the three password-reset routes beneath /account-kit')
    }
  }
  run('pnpm', specCommand)
  evidence.adonisVersion = JSON.parse(
    await readFile(join(appRoot, 'node_modules/@adonisjs/core/package.json'), 'utf8')
  ).version
  const require = createRequire(join(appRoot, 'package.json'))
  const Database = require('better-sqlite3')
  const connection = new Database(':memory:')
  evidence.databaseVersion = connection.prepare('select sqlite_version() as version').get().version
  connection.close()
  if ((await digest(candidate)) !== evidence.candidateSha256)
    throw new Error('Candidate archive changed during verification')
  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'
  evidence.error = error.stack ?? String(error)
  throw error
} finally {
  await writeFile(join(retained, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ ...evidence, commands: undefined }, null, 2))
  console.log(`Evidence: ${join(retained, 'evidence.json')}`)
  console.log(`Retained scaffold: ${appRoot}`)
  console.log(`Spec command: ${evidence.specCommand}`)
  console.log(
    'Limits: SQLite and local notification capture; no recipient delivery or browser coverage.'
  )
}
