// Converts each asciicast to matching animated and static SVGs for the docs.
// Usage: node bin/demos/render.ts <cast-dir> <svg-dir>
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

const [castDir, svgDir] = process.argv.slice(2)
if (!castDir || !svgDir) throw new Error('Usage: node bin/demos/render.ts <cast-dir> <svg-dir>')
mkdirSync(svgDir, { recursive: true })
for (const file of readdirSync(castDir).filter((name) => name.endsWith('.cast'))) {
  const input = join(castDir, file)
  const events: unknown[] = readFileSync(input, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line))
  // The recorders append an empty hold event. Select the last visible output before that hold.
  const frame = events.findLast(
    (event): event is [number, 'o', string] =>
      Array.isArray(event) &&
      Number.isFinite(event[0]) &&
      event[0] >= 0 &&
      event[1] === 'o' &&
      typeof event[2] === 'string' &&
      stripVTControlCharacters(event[2]).trim().length > 0
  )
  if (!frame) throw new Error(`No visible output in ${input}`)
  const stem = basename(file, '.cast')
  const options = ['--in', input, '--window', '--width', '100', '--height', '24', '--padding', '12']
  for (const [name, extra] of [
    [`${stem}.svg`, []],
    [`${stem}_still.svg`, ['--at', String(Math.ceil(frame[0] * 1000)), '--no-cursor']],
  ] as const) {
    const out = join(svgDir, name)
    execFileSync('pnpm', ['dlx', 'svg-term-cli@2.1.1', ...options, '--out', out, ...extra], {
      stdio: 'inherit',
    })
    console.log(out)
  }
}
