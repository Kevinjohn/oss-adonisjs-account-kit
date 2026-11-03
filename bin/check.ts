import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectedSteps } from './check_profiles.js'

const root = fileURLToPath(new URL('../', import.meta.url))
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24')

for (const step of selectedSteps(process.argv.slice(2))) {
  const command = ['pnpm', step.script, ...(step.args ?? [])].join(' ')
  const where = step.directory ? ` (in ${step.directory})` : ''
  console.log(`[check] ${command}${where}`)
  const result = spawnSync('pnpm', [step.script, ...(step.args ?? [])], {
    cwd: join(root, step.directory ?? ''),
    env: { ...process.env, ...step.env },
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error(`[check] FAILED: ${command}${where}`)
    process.exit(result.status ?? 1)
  }
}
console.log('[check] PASS')
