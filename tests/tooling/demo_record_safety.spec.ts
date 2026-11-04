import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const createFeature = join(repoRoot, 'bin/demos/create_app.ts')
const createSetup = join(repoRoot, 'bin/demos/create_setup_app.ts')
const recordFeature = join(repoRoot, 'bin/demos/record.ts')
const recordSetup = join(repoRoot, 'bin/demos/record_setup.ts')

type Result = { code: number | null; output: string }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-demo-safety-'))
  const bin = join(root, 'bin')
  const trace = join(root, 'commands.log')
  await mkdir(bin)
  await writeFile(
    join(bin, 'pnpm'),
    `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.DEMO_TRACE, 'pnpm ' + args.join(' ') + '\\n')
if (args.includes('pack')) {
  const destination = args[args.indexOf('--pack-destination') + 1]
  fs.writeFileSync(path.join(destination, 'kevinjohn-adonisjs-account-kit-synthetic.tgz'), 'synthetic archive')
}
if (args[0] === 'dlx' && args[1] === 'create-adonisjs@3.4.0') {
  const app = path.join(process.cwd(), args[2])
  fs.mkdirSync(path.join(app, 'config'), { recursive: true })
  fs.mkdirSync(path.join(app, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(app, 'start'), { recursive: true })
  fs.mkdirSync(path.join(app, 'app'), { recursive: true })
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: path.basename(app), dependencies: { '@adonisjs/core': '^7.0.0', '@adonisjs/lucid': '^22.0.0', 'better-sqlite3': '^13.0.0' } }))
  fs.writeFileSync(path.join(app, 'ace'), '// synthetic ace entry\\n')
  fs.writeFileSync(path.join(app, 'config/database.ts'), "import app from '@adonisjs/core/services/app'\\nimport { defineConfig } from '@adonisjs/lucid'\\nconst dbConfig = defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', connection: { filename: app.tmpPath('db.sqlite3') }, useNullAsDefault: true, migrations: { naturalSort: true, paths: ['database/migrations'] }, schemaGeneration: { enabled: true, rulesPaths: ['database/schema_rules.js'] } } } })\\nexport default dbConfig\\n")
  fs.writeFileSync(path.join(app, 'start/routes.ts'), '// synthetic routes\\n')
  fs.writeFileSync(path.join(app, 'adonisrc.ts'), "const commands = [() => import('@adonisjs/mail/commands')]\\nexport default { commands }\\n")
}
if (args[0] === 'add' && process.env.FAIL_PREPARATION === '1') process.exit(23)
`
  )
  await writeFile(
    join(bin, 'node'),
    `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.DEMO_TRACE, JSON.stringify({ command: 'node', args, connection: process.env.DB_CONNECTION, database: process.env.DB_DATABASE, nodeOptions: process.env.NODE_OPTIONS }) + '\\n')
if (args[0] === 'ace' && args[1] === 'serve') {
  console.log('started HTTP server')
  process.on('SIGTERM', () => { fs.appendFileSync(process.env.DEMO_TRACE, 'server-cleaned\\n'); process.exit(0) })
  setInterval(() => {}, 1000)
} else if (args[0] === 'ace' && args[1] === 'account-kit:doctor') console.log('fake doctor')
else if (args[0] === 'ace' && args[1] === 'account-kit:setup') {
  if (args.includes('--apply')) fs.writeFileSync('.setup-applied', 'yes')
  console.log('[ info ] {\\n  "pillars": {},\\n  "changes": [],\\n  "prerequisites": []\\n}')
}
`
  )
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh
echo "git $*" >> "$DEMO_TRACE"
case "$1" in
  init) mkdir -p .git ;;
  add) if [ -f .account-kit-demo.json ]; then cp .account-kit-demo.json .git/staged-demo-marker; fi ;;
  commit) ;;
  rev-parse) pwd ;;
  ls-files) if [ -f .git/staged-demo-marker ]; then echo .account-kit-demo.json; else exit 1; fi ;;
  show) cat .git/staged-demo-marker ;;
  reset) rm -f .setup-applied ;;
  clean) ;;
  status) if [ -f .setup-applied ]; then echo ' M app/created.ts'; fi ;;
esac
`
  )
  await Promise.all(['pnpm', 'node', 'git'].map((name) => chmod(join(bin, name), 0o755)))

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DEMO_TRACE: trace,
  }
  const run = (script: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<Result>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import=@poppinss/ts-exec', script, ...args], {
        cwd: repoRoot,
        env: { ...env, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout!.on('data', (chunk) => (output += chunk))
      child.stderr!.on('data', (chunk) => (output += chunk))
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, output }))
    })
  const clearTrace = () => writeFile(trace, '')
  const traceText = async () => readFile(trace, 'utf8').catch(() => '')
  return {
    root,
    bin,
    trace,
    env,
    run,
    clearTrace,
    traceText,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function marker(appDir: string) {
  return JSON.parse(await readFile(join(appDir, '.account-kit-demo.json'), 'utf8')) as {
    version: number
    role: string
    root: string
  }
}

test.group('demo recording safety', (group) => {
  group.each.timeout(30_000)

  test('feature producer marker validates and record binds migration and server to its SQLite file', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'feature-app')
    const prepared = await f.run(createFeature, [appDir])
    assert.equal(prepared.code, 0, prepared.output)
    const identity = await marker(appDir)
    assert.equal(identity.version, 1)
    assert.equal(identity.role, 'feature-recording')
    assert.equal(identity.root, appDir)

    await f.clearTrace()
    const recorded = await f.run(recordFeature, [appDir, join(f.root, 'casts'), 'doctor'])
    assert.equal(recorded.code, 0, recorded.output)
    const trace = await f.traceText()
    const events = trace
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as {
            command: string
            args: string[]
            connection: string
            database: string
            nodeOptions: string | undefined
          }
        } catch {
          return undefined
        }
      })
      .filter((entry) => entry?.command === 'node')
    assert.ok(events.some((event) => event?.args.includes('migration:fresh')))
    assert.ok(events.some((event) => event?.args.includes('serve')))
    for (const event of events) {
      assert.equal(event?.connection, 'sqlite')
      assert.equal(event?.database, join(appDir, 'tmp/db.sqlite3'))
      assert.equal(event?.nodeOptions, undefined)
    }
  })

  test('setup producer tracks its marker before starter commit and repeated recordings preserve it', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'setup-app')
    const prepared = await f.run(createSetup, [appDir])
    assert.equal(prepared.code, 0, prepared.output)
    const original = await readFile(join(appDir, '.account-kit-demo.json'), 'utf8')
    const identity = await marker(appDir)
    assert.equal(identity.role, 'setup-recording')
    assert.equal(await readFile(join(appDir, '.git/staged-demo-marker'), 'utf8'), original)

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.run(recordSetup, [appDir, join(f.root, `casts-${attempt}`)])
      assert.equal(result.code, 0, result.output)
      assert.equal(await readFile(join(appDir, '.account-kit-demo.json'), 'utf8'), original)
    }
    const trace = await f.traceText()
    assert.equal((trace.match(/git reset/g) ?? []).length, 2)
    assert.equal((trace.match(/git clean/g) ?? []).length, 2)
    const setupCommands = trace
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { args: string[]; connection: string; database: string })
      .filter((event) => event.args.includes('account-kit:setup'))
    assert.equal(setupCommands.length, 4)
    for (const event of setupCommands) {
      assert.equal(event.connection, 'sqlite')
      assert.equal(event.database, join(appDir, 'tmp/db.sqlite3'))
    }
  })

  test('missing, wrong-root and wrong-role markers refuse before destructive commands', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const cases = [
      { name: 'missing', role: 'setup-recording', root: null },
      { name: 'wrong-root', role: 'setup-recording', root: join(f.root, 'elsewhere') },
      { name: 'wrong-role', role: 'feature-recording', root: undefined },
      { name: 'untracked-marker', role: 'setup-recording', root: undefined },
    ]
    for (const item of cases) {
      const appDir = join(f.root, item.name)
      await writeSyntheticApp(appDir, item.role, item.root)
      await f.clearTrace()
      const result = await f.run(recordSetup, [appDir, join(f.root, `out-${item.name}`)])
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /demo identity/)
      assert.doesNotMatch(await f.traceText(), /git reset|git clean|migration:fresh/)
    }
  })

  test('setup marker must match the committed starter before reset or clean', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'marker-commit-app')
    const prepared = await f.run(createSetup, [appDir])
    assert.equal(prepared.code, 0, prepared.output)
    await writeFile(
      join(appDir, '.git/staged-demo-marker'),
      JSON.stringify({ version: 1, role: 'setup-recording', root: join(f.root, 'wrong-root') })
    )
    await f.clearTrace()

    const result = await f.run(recordSetup, [appDir, join(f.root, 'out')])
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /match its committed starter copy/)
    assert.doesNotMatch(await f.traceText(), /git reset|git clean/)
  })

  test('inherited external database settings refuse before migration', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'external-env-app')
    const prepared = await f.run(createFeature, [appDir])
    assert.equal(prepared.code, 0)
    await f.clearTrace()
    const result = await f.run(recordFeature, [appDir, join(f.root, 'out'), 'doctor'], {
      DB_CONNECTION: 'pg',
      DB_HOST: 'db.example.invalid',
    })
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /refusing inherited database override/)
    assert.doesNotMatch(await f.traceText(), /migration:fresh/)
  })

  test('inherited Node preload options refuse before migration', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'node-options-app')
    const prepared = await f.run(createFeature, [appDir])
    assert.equal(prepared.code, 0, prepared.output)
    await f.clearTrace()
    const result = await f.run(recordFeature, [appDir, join(f.root, 'out'), 'doctor'], {
      NODE_OPTIONS: '--no-warnings',
    })
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /refusing inherited NODE_OPTIONS/)
    assert.doesNotMatch(await f.traceText(), /migration:fresh/)
  })

  test('database symlink escaping the app root refuses before reset or migration', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'symlink-app')
    const prepared = await f.run(createSetup, [appDir])
    assert.equal(prepared.code, 0)
    const external = join(f.root, 'external.sqlite3')
    await writeFile(external, 'keep')
    await symlink(external, join(appDir, 'tmp/db.sqlite3'))

    await f.clearTrace()
    const result = await f.run(recordSetup, [appDir, join(f.root, 'out')])
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /SQLite database must be a regular file/)
    assert.doesNotMatch(await f.traceText(), /git reset|git clean|migration:fresh/)
    const externalStat = await lstat(external)
    assert.equal(externalStat.isFile(), true)
  })

  test('external or ambiguous SQLite configuration refuses before reset or migration', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'external-config-app')
    const prepared = await f.run(createSetup, [appDir])
    assert.equal(prepared.code, 0)
    const databaseConfig = join(appDir, 'config/database.ts')
    const original = await readFile(databaseConfig, 'utf8')
    await writeFile(
      databaseConfig,
      original.replace("app.tmpPath('db.sqlite3')", "'/outside/ordinary.sqlite3'")
    )

    await f.clearTrace()
    const result = await f.run(recordSetup, [appDir, join(f.root, 'out')])
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /generated database config must select better-sqlite3/)
    assert.doesNotMatch(await f.traceText(), /git reset|git clean|migration:fresh/)
  })

  test('unsafe database config structure refuses before reset or migration', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const cases = [
      {
        name: 'side-effect-import',
        mutate: (source: string) => `import './untrusted-config.js'\n${source}`,
      },
      {
        name: 'computed-override',
        mutate: (source: string) =>
          source.replace("connection: 'sqlite',", "connection: 'sqlite', ['connection']: 'pg',"),
      },
      {
        name: 'extra-executable-argument',
        mutate: (source: string) =>
          source.replace(
            "schemaGeneration: { enabled: true, rulesPaths: ['database/schema_rules.js'] } } } })",
            "schemaGeneration: { enabled: true, rulesPaths: ['database/schema_rules.js'] } } } }, { connection: 'pg' })"
          ),
      },
    ]

    for (const item of cases) {
      const appDir = join(f.root, item.name)
      const prepared = await f.run(createSetup, [appDir])
      assert.equal(prepared.code, 0, prepared.output)
      const configPath = join(appDir, 'config/database.ts')
      const source = await readFile(configPath, 'utf8')
      const mutated = item.mutate(source)
      assert.notEqual(mutated, source, `${item.name} fixture must modify the config`)
      await writeFile(configPath, mutated)
      await f.clearTrace()

      const result = await f.run(recordSetup, [appDir, join(f.root, `out-${item.name}`)])
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /generated database config/)
      assert.doesNotMatch(await f.traceText(), /git reset|git clean|migration:fresh/)
    }
  })

  test('a symlinked temporary directory refuses before destructive commands', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'tmp-link-app')
    const prepared = await f.run(createFeature, [appDir])
    assert.equal(prepared.code, 0)
    const movedTmp = join(f.root, 'external-tmp')
    await rm(join(appDir, 'tmp'), { recursive: true })
    await mkdir(movedTmp)
    await symlink(movedTmp, join(appDir, 'tmp'))

    await f.clearTrace()
    const result = await f.run(recordFeature, [appDir, join(f.root, 'out'), 'doctor'])
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /demo temporary directory must be a real directory/)
    assert.doesNotMatch(await f.traceText(), /migration:fresh/)
  })

  test('failed preparation leaves no demo marker for either producer', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    for (const [script, name] of [
      [createFeature, 'failed-feature'],
      [createSetup, 'failed-setup'],
    ] as const) {
      const appDir = join(f.root, name)
      const result = await f.run(script, [appDir], { FAIL_PREPARATION: '1' })
      assert.equal(result.code, 1, result.output)
      await assert.rejects(readFile(join(appDir, '.account-kit-demo.json')))
    }
  })
})

async function writeSyntheticApp(appDir: string, role: string, markerRoot: string | null = appDir) {
  await mkdir(join(appDir, 'config'), { recursive: true })
  await mkdir(join(appDir, 'tmp'), { recursive: true })
  await writeFile(
    join(appDir, 'package.json'),
    JSON.stringify({
      name: basename(appDir),
      dependencies: { '@adonisjs/core': '^7', '@adonisjs/lucid': '^22', 'better-sqlite3': '^13' },
    })
  )
  await writeFile(join(appDir, 'ace'), '')
  await writeFile(
    join(appDir, 'config/database.ts'),
    `import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/lucid'
const dbConfig = defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', connection: { filename: app.tmpPath('db.sqlite3') }, useNullAsDefault: true, migrations: { naturalSort: true, paths: ['database/migrations'] }, schemaGeneration: { enabled: true, rulesPaths: ['database/schema_rules.js'] } } } })
export default dbConfig
`
  )
  await mkdir(join(appDir, '.git'))
  if (markerRoot !== null)
    await writeFile(
      join(appDir, '.account-kit-demo.json'),
      JSON.stringify({ version: 1, role, root: markerRoot })
    )
}
