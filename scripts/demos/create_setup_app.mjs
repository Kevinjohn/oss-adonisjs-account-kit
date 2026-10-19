// Builds a fresh AdonisJS API app that is ready for account-kit:setup, for record_setup.mjs.
// Usage: node scripts/demos/create_setup_app.mjs <app-dir>
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packCheckout, run } from './pack_checkout.mjs'

const [target] = process.argv.slice(2)
if (!target) throw new Error('Usage: node scripts/demos/create_setup_app.mjs <app-dir>')
const appDir = resolve(target)
if (existsSync(appDir)) throw new Error(`${appDir} already exists; remove it or pick another path`)
const choices = fileURLToPath(new URL('../../docs/setup_choices.api.example.json', import.meta.url))

const tarball = packCheckout(dirname(appDir))

run(
  'npx',
  ['-y', 'create-adonisjs@3.4.0', basename(appDir), '--kit=api', '--pkg=npm'],
  dirname(appDir)
)
// Setup's prerequisites: TypeScript to inspect the app, Mail and a limiter store.
const packages = ['typescript@^5.9.3', '@adonisjs/mail@^10', '@adonisjs/limiter']
run('npm', ['install', join('..', tarball), ...packages], appDir)
run('node', ['ace', 'configure', '@adonisjs/mail', '--transports=smtp'], appDir)
run('node', ['ace', 'configure', '@adonisjs/limiter', '--store=database'], appDir)

// The commands are registered by hand; setup does not use `configure`.
const rc = join(appDir, 'adonisrc.ts')
const commands = "() => import('@adonisjs/mail/commands')"
const source = readFileSync(rc, 'utf8')
if (!source.includes(commands)) throw new Error('adonisrc.ts has no Mail commands entry')
writeFileSync(
  rc,
  source.replace(commands, `${commands},\n    () => import('adonisjs-account-kit/commands')`)
)
appendFileSync(
  join(appDir, '.env'),
  '\nACCOUNT_MAIL_FROM=accounts@example.com\nFRONTEND_URL=http://localhost:5173\n'
)

// The API choices select authentication, which needs an application-owned access policy.
mkdirSync(join(appDir, 'app/services'), { recursive: true })
writeFileSync(
  join(appDir, 'app/services/account_kit_policy.ts'),
  `import type User from '#models/user'

export const accountKitPolicy = {
  async canAccess(user: User) {
    return user.email !== 'blocked@example.com'
  },
}
`
)
copyFileSync(choices, join(appDir, 'choices.json'))

// A first commit lets the recording show what setup writes.
if (!existsSync(join(appDir, '.git'))) run('git', ['init', '-q'], appDir)
run('git', ['add', '-A'], appDir)
const identity = ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com']
run('git', [...identity, 'commit', '-qm', 'Starter app'], appDir)
console.log(`Setup demo app ready in ${appDir}`)
