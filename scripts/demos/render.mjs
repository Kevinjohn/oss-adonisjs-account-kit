// Converts each asciicast in a directory to an animated SVG for the docs.
// Usage: node scripts/demos/render.mjs <cast-dir> <svg-dir>
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const [castDir, svgDir] = process.argv.slice(2)
if (!castDir || !svgDir)
  throw new Error('Usage: node scripts/demos/render.mjs <cast-dir> <svg-dir>')
mkdirSync(svgDir, { recursive: true })
for (const file of readdirSync(castDir).filter((name) => name.endsWith('.cast'))) {
  const out = join(svgDir, `${basename(file, '.cast')}.svg`)
  const size = ['--width', '100', '--height', '24', '--padding', '12']
  execFileSync(
    'npx',
    ['-y', 'svg-term-cli@2.1.1', '--in', join(castDir, file), '--out', out, '--window', ...size],
    { stdio: 'inherit' }
  )
  console.log(out)
}
