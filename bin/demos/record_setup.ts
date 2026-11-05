// Records account-kit:setup previewing, then applying, the API choices on a setup demo app.
// Usage: node bin/demos/record_setup.ts <app-dir> <out-dir>
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Cast } from './cast.js'
import {
  assertDatabaseInventory,
  shadowPaths,
  starterPaths,
  verifySnapshot,
} from './starter_contract.js'
import { validateDemoIdentity } from './demo_identity.js'
type SetupReport = {
  pillars: Record<string, string>
  changes: { path: string; action: string }[]
  prerequisites: string[]
}

const [app, outDir] = process.argv.slice(2)
if (!app || !outDir) throw new Error('Usage: node record_setup.ts <app-dir> <out-dir>')
const demo = validateDemoIdentity(app, 'setup-recording', process.env, true)
const appDir = demo.root

const run = (command: string, args: string[]) =>
  execFileSync(command, args, { cwd: appDir, env: demo.childEnv, encoding: 'utf8' })

/** Runs setup: its JSON report is stdout, and the lines it prints on stderr follow it. */
function setup(args: string[]) {
  const result = spawnSync('node', ['ace', 'account-kit:setup', ...args], {
    cwd: appDir,
    env: demo.childEnv,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`setup failed:\n${result.stdout}${result.stderr}`)
  return {
    report: JSON.parse(result.stdout) as SetupReport,
    after: result.stderr.split('\n').filter((line) => line.startsWith('[ info ]')),
  }
}

/** One line per pillar. */
const pillars = (report: SetupReport) =>
  Object.entries(report.pillars).map(([name, value]) => `  ${name.padEnd(16)}${value}`)

/** One line per file change, with the generated migrations folded into one line. */
function changes(report: SetupReport) {
  const migration = /^database\/migrations\/\d+_account_kit_.*\.ts$/
  const count = report.changes.filter((change) => migration.test(change.path)).length
  const lines: string[] = []
  for (const change of report.changes) {
    const action = `  \x1b[33m${change.action.padEnd(8)}\x1b[0m`
    if (!migration.test(change.path)) lines.push(`${action}${change.path}`)
    else if (!lines.some((line) => line.includes('database/migrations')))
      lines.push(`${action}database/migrations/…_account_kit_*.ts  (${count} migrations)`)
  }
  return lines
}

const info = (line: string) => line.replace('[ info ]', '\x1b[34m[ info ]\x1b[0m')

// Start from the committed starter app, so the recording can be run again. Without its own
// repository, git would find an enclosing one, such as this checkout, and reset that instead.
const root = run('git', ['rev-parse', '--show-toplevel']).trim()
if (realpathSync(root) !== realpathSync(appDir))
  throw new Error(`${appDir} is not a setup demo app; run create_setup_app.ts first`)
let trackedMarker: string
try {
  trackedMarker = execFileSync(
    'git',
    ['ls-files', '--error-unmatch', '--', '.account-kit-demo.json'],
    { cwd: appDir, env: demo.childEnv, encoding: 'utf8' }
  ).trim()
} catch (error) {
  if ((error as NodeJS.ErrnoException & { status?: number }).status === 1)
    throw new Error('setup demo identity marker must be tracked before recording', { cause: error })
  throw error
}
if (trackedMarker !== '.account-kit-demo.json')
  throw new Error('setup demo identity marker must be tracked before recording')
const markerEntry = run('git', ['ls-tree', 'HEAD', '--', '.account-kit-demo.json']).trim()
if (!markerEntry.startsWith('100644 blob ') && !markerEntry.startsWith('100755 blob '))
  throw new Error('committed demo marker must be a regular file')
const committedMarker = run('git', ['show', 'HEAD:.account-kit-demo.json'])
const workingMarker = readFileSync(join(appDir, '.account-kit-demo.json'), 'utf8')
if (committedMarker !== workingMarker)
  throw new Error('setup demo identity marker must match its committed starter copy')
const snapshot = (JSON.parse(committedMarker) as { starter: Record<string, string> }).starter
const committedFiles = Object.fromEntries(
  starterPaths.map((path) => {
    const entry = run('git', ['ls-tree', 'HEAD', '--', path]).trim()
    if (!entry.startsWith('100644 blob ') && !entry.startsWith('100755 blob '))
      throw new Error(`committed starter file must be a regular file: ${path}`)
    return [path, run('git', ['show', `HEAD:${path}`])]
  })
)
const configFiles = run('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'config'])
  .split('\0')
  .filter(Boolean)
  .map((path) => path.slice('config/'.length))
assertDatabaseInventory(configFiles)
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  const path = `tmp/db.sqlite3${suffix}`
  const entry = run('git', ['ls-tree', 'HEAD', '--', path]).trim()
  if (entry && !entry.startsWith('100644 blob ') && !entry.startsWith('100755 blob '))
    throw new Error(`committed SQLite path must be a regular file: ${path}`)
}
verifySnapshot(committedFiles, snapshot)
for (const path of shadowPaths) {
  if (run('git', ['ls-tree', 'HEAD', '--', path]).trim())
    throw new Error(`committed starter has an overriding entrypoint: ${path}`)
}
// A tracked tmp symlink would replace the checked directory during reset.
for (const path of ['tmp', 'bin', 'config']) {
  const entry = run('git', ['ls-tree', 'HEAD', '--', path]).trim()
  if (entry && !entry.startsWith('040000 tree '))
    throw new Error(`committed starter directory must be a tree: ${path}`)
}
run('git', ['reset', '-q', '--hard'])
run('git', ['clean', '-fdq'])
validateDemoIdentity(appDir, 'setup-recording', demo.childEnv)

const cast = new Cast()
cast.comment('preview the choices file: nothing is written yet')
cast.type('node ace account-kit:setup --input=choices.json')
const preview = setup(['--input=choices.json'])
cast.print(
  ['pillars', ...pillars(preview.report), 'changes', ...changes(preview.report)].join('\n')
)
cast.type('git status --short')
const untouched = run('git', ['status', '--short'])
if (untouched) throw new Error(`preview wrote files:\n${untouched}`)
cast.print('', 0.3)

cast.comment('apply the same plan')
cast.type('node ace account-kit:setup --input=choices.json --apply')
const applied = setup(['--input=choices.json', '--apply'])
const steps = applied.report.prerequisites.map((step) => `  - ${step}`)
cast.print(['next steps', ...steps, ...applied.after.map(info)].join('\n'))
cast.type('git status --short | grep -v database/migrations')
cast.print(
  run('git', ['status', '--short'])
    .split('\n')
    .filter((line) => line && !line.includes('database/migrations'))
    .join('\n')
)
cast.emit('', 2.5)

mkdirSync(outDir, { recursive: true })
cast.save(join(outDir, 'setup.cast'), 'Account Kit: setup')
console.log(`setup: ${cast.t.toFixed(1)} s`)
