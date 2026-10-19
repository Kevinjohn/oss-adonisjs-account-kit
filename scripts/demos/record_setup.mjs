// Records account-kit:setup previewing, then applying, the API choices on a setup demo app.
// Usage: node scripts/demos/record_setup.mjs <app-dir> <out-dir>
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Cast } from './cast.mjs'

const [appDir, outDir] = process.argv.slice(2)
if (!appDir || !outDir) throw new Error('Usage: node record_setup.mjs <app-dir> <out-dir>')

const sh = (command) => execFileSync('bash', ['-c', command], { cwd: appDir, encoding: 'utf8' })

/** Splits setup's output into its JSON report and the lines printed after it. */
function parse(output) {
  const lines = output.split('\n')
  const start = lines.findIndex((line) => line.startsWith('[ info ] {'))
  const end = lines.indexOf('}', start)
  if (start === -1 || end === -1) throw new Error(`no setup report in:\n${output}`)
  const json = ['{', ...lines.slice(start + 1, end + 1)].join('\n')
  return { report: JSON.parse(json), after: lines.slice(end + 1).filter(Boolean) }
}

/** One line per pillar. */
const pillars = (report) =>
  Object.entries(report.pillars).map(([name, value]) => `  ${name.padEnd(16)}${value}`)

/** One line per file change, with the generated migrations folded into one line. */
function changes(report) {
  const migration = /^database\/migrations\/\d+_account_kit_.*\.ts$/
  const count = report.changes.filter((change) => migration.test(change.path)).length
  const lines = []
  for (const change of report.changes) {
    const action = `  \x1b[33m${change.action.padEnd(8)}\x1b[0m`
    if (!migration.test(change.path)) lines.push(`${action}${change.path}`)
    else if (!lines.some((line) => line.includes('database/migrations')))
      lines.push(`${action}database/migrations/…_account_kit_*.ts  (${count} migrations)`)
  }
  return lines
}

const info = (line) => line.replace('[ info ]', '\x1b[34m[ info ]\x1b[0m')

// Start from the committed starter app, so the recording can be run again.
sh('git reset -q --hard && git clean -fdq')

const cast = new Cast()
cast.comment('preview the choices file: nothing is written yet')
cast.type('node ace account-kit:setup --input=choices.json')
const preview = parse(sh('node ace account-kit:setup --input=choices.json'))
cast.print(
  ['pillars', ...pillars(preview.report), 'changes', ...changes(preview.report)].join('\n')
)
cast.type('git status --short')
const untouched = sh('git status --short')
if (untouched) throw new Error(`preview wrote files:\n${untouched}`)
cast.print('', 0.3)

cast.comment('apply the same plan')
cast.type('node ace account-kit:setup --input=choices.json --apply')
const applied = parse(sh('node ace account-kit:setup --input=choices.json --apply'))
const steps = applied.report.prerequisites.map((step) => `  - ${step}`)
cast.print(['next steps', ...steps, ...applied.after.map(info)].join('\n'))
cast.type('git status --short | grep -v database/migrations')
cast.print(sh('git status --short | grep -v database/migrations'))
cast.emit('', 2.5)

mkdirSync(outDir, { recursive: true })
cast.save(join(outDir, 'setup.cast'), 'Account Kit: setup')
console.log(`setup: ${cast.t.toFixed(1)} s`)
