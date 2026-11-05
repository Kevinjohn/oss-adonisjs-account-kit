import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { starterAce, starterConsole } from '../../bin/demos/starter_contract.js'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const createFeature = join(repoRoot, 'bin/demos/create_app.ts')
const createSetup = join(repoRoot, 'bin/demos/create_setup_app.ts')
const packageName = '@kevinjohn/adonisjs-account-kit'
const packageVersion = '0.2.0-test'

type Result = { code: number | null; output: string }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-demo-pack-'))
  const bin = join(root, 'bin')
  const trace = join(root, 'commands.jsonl')
  await mkdir(bin)
  await writeFile(
    join(bin, 'pnpm'),
    `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const trace = (entry) => fs.appendFileSync(process.env.DEMO_TRACE, JSON.stringify(entry) + '\\n')
trace({ command: 'pnpm', args, cwd: process.cwd() })
if (args[0] === 'build') process.exit(0)
if (args.includes('pack')) {
  if (process.env.DEMO_FAIL === 'pack') process.exit(21)
  const archive = args[args.indexOf('--out') + 1]
  if (!archive || !path.isAbsolute(archive) || !archive.endsWith('/candidate.tgz')) process.exit(22)
  const source = path.join(path.dirname(archive), 'package')
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: ${JSON.stringify(packageName)}, version: ${JSON.stringify(packageVersion)} }))
  execFileSync('tar', ['-czf', archive, '-C', path.dirname(archive), 'package'])
  process.exit(0)
}
if (args[0] === 'dlx') {
  if (process.env.DEMO_FAIL === 'scaffold') process.exit(23)
  const app = path.join(process.cwd(), args[2])
  fs.mkdirSync(path.join(app, 'config'), { recursive: true })
  fs.mkdirSync(path.join(app, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(app, 'start'), { recursive: true })
  fs.mkdirSync(path.join(app, 'app'), { recursive: true })
  fs.mkdirSync(path.join(app, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(app, 'database'), { recursive: true })
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: path.basename(app), dependencies: { '@adonisjs/core': '^7.0.0', '@adonisjs/lucid': '^22.0.0', 'better-sqlite3': '^13.0.0' } }))
  fs.writeFileSync(path.join(app, 'ace.js'), ${JSON.stringify(starterAce)})
  fs.writeFileSync(path.join(app, 'bin/console.ts'), ${JSON.stringify(starterConsole)})
  fs.writeFileSync(path.join(app, 'config/database.ts'), "import app from '@adonisjs/core/services/app'\\nimport { defineConfig } from '@adonisjs/lucid'\\nconst dbConfig = defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', connection: { filename: app.tmpPath('db.sqlite3') }, useNullAsDefault: true, migrations: { naturalSort: true, paths: ['database/migrations'] }, schemaGeneration: { enabled: true, rulesPaths: ['database/schema_rules.js'] } } } })\\nexport default dbConfig\\n")
  fs.writeFileSync(path.join(app, 'start/routes.ts'), '// generated routes\\n')
  fs.writeFileSync(path.join(app, 'adonisrc.ts'), "import { defineConfig } from '@adonisjs/core/app'\\nexport default defineConfig({ commands: [() => import('@adonisjs/mail/commands')] })\\n")
  process.exit(0)
}
if (args[0] === 'add' && process.env.DEMO_FAIL === 'install') process.exit(24)
if (args[0] === 'add') {
  const candidate = args.find((arg) => path.isAbsolute(arg) && arg.endsWith('.tgz'))
  trace({ selectedArchive: candidate })
  if (!candidate || !fs.existsSync(candidate)) process.exit(25)
}
`
  )
  await writeFile(join(bin, 'node'), `#!${process.execPath}\nprocess.exit(0)\n`)
  await writeFile(join(bin, 'git'), `#!${process.execPath}\nprocess.exit(0)\n`)
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
  const events = async () => {
    const source = await readFile(trace, 'utf8').catch(() => '')
    return source
      .split('\n')
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line) as { command: string; args: string[]; selectedArchive?: string }
      )
  }
  const archiveFolders = async (appDir: string) => {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith(`${basename(appDir)}.account-kit-archive-`)
      )
      .map((entry) => join(root, entry.name))
  }
  return {
    root,
    run,
    events,
    archiveFolders,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test.group('demo checkout archive', (group) => {
  group.each.timeout(30_000)

  for (const [name, script] of [
    ['feature', createFeature],
    ['setup', createSetup],
  ] as const) {
    test(`${name} installer consumes the selected absolute archive and keeps it beside the app`, async (t) => {
      const f = await fixture()
      t.cleanup(f.cleanup)
      const appDir = join(f.root, `${name}-app`)
      await writeFile(join(f.root, 'kevinjohn-adonisjs-account-kit-stale.tgz'), 'stale sibling')

      const result = await f.run(script, [appDir])
      assert.equal(result.code, 0, result.output)
      const folders = await f.archiveFolders(appDir)
      assert.equal(folders.length, 1)
      const archivePath = join(folders[0]!, 'candidate.tgz')
      const bytes = await readFile(archivePath)
      const digest = createHash('sha256').update(bytes).digest('hex')
      const metadata = JSON.parse(
        await new Promise<string>((resolve, reject) => {
          const child = spawn('tar', ['-xOf', archivePath, 'package/package.json'])
          let output = ''
          child.stdout!.on('data', (chunk) => (output += chunk))
          child.once('error', reject)
          child.once('close', (code) =>
            code === 0 ? resolve(output) : reject(new Error(`tar exited ${code}`))
          )
        })
      ) as { name: string; version: string }
      assert.deepEqual(metadata, { name: packageName, version: packageVersion })
      assert.deepEqual(JSON.parse(await readFile(join(folders[0]!, 'candidate.json'), 'utf8')), {
        archivePath,
        sha256: digest,
        packageName,
        packageVersion,
      })
      const events = await f.events()
      const add = events.find((entry) => entry.command === 'pnpm' && entry.args[0] === 'add')
      assert.ok(add)
      assert.equal(add.args[1], archivePath)
      assert.equal(events.find((entry) => entry.selectedArchive)?.selectedArchive, archivePath)
      assert.notEqual(archivePath, join(f.root, 'kevinjohn-adonisjs-account-kit-stale.tgz'))

      await rm(join(f.root, 'kevinjohn-adonisjs-account-kit-stale.tgz'))
      const retainedBytes = await readFile(archivePath)
      assert.equal(retainedBytes.equals(bytes), true)
      const candidateMetadata = await readFile(join(folders[0]!, 'candidate.json'), 'utf8')
      assert.equal(candidateMetadata.includes(digest), true)
    })
  }

  test('an app directory under a missing parent creates that parent first', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'tmp', 'demo-app')
    const result = await f.run(createFeature, [appDir])
    assert.equal(result.code, 0, result.output)
    const appPackage = await readFile(join(appDir, 'package.json'))
    assert.ok(appPackage.length > 0)
  })

  test('pack failure leaves its owned archive folder for diagnosis', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'pack-failure-app')
    const result = await f.run(createFeature, [appDir], { DEMO_FAIL: 'pack' })
    assert.notEqual(result.code, 0)
    const folders = await f.archiveFolders(appDir)
    assert.equal(folders.length, 1)
    assert.equal(
      await readFile(join(folders[0]!, 'candidate.tgz')).catch(() => undefined),
      undefined
    )
  })

  test('scaffold failure leaves the packed archive and metadata available', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'scaffold-failure-app')
    const result = await f.run(createFeature, [appDir], { DEMO_FAIL: 'scaffold' })
    assert.notEqual(result.code, 0)
    const folders = await f.archiveFolders(appDir)
    assert.equal(folders.length, 1)
    const archive = await readFile(join(folders[0]!, 'candidate.tgz'))
    assert.ok(archive.length > 0)
    assert.match(
      await readFile(join(folders[0]!, 'candidate.json'), 'utf8'),
      new RegExp(packageVersion)
    )
  })

  test('install failure retains the archive beside the generated app', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const appDir = join(f.root, 'install-failure-app')
    const result = await f.run(createSetup, [appDir], { DEMO_FAIL: 'install' })
    assert.notEqual(result.code, 0)
    const folders = await f.archiveFolders(appDir)
    assert.equal(folders.length, 1)
    const appPackage = await readFile(join(appDir, 'package.json'))
    assert.ok(appPackage.length > 0)
    const archive = await readFile(join(folders[0]!, 'candidate.tgz'))
    const metadata = await readFile(join(folders[0]!, 'candidate.json'))
    assert.ok(archive.length > 0)
    assert.ok(metadata.length > 0)
  })
})
