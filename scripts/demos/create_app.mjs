// Builds a fresh AdonisJS API app with the packed Account Kit, ready for record.mjs.
// Usage: node scripts/demos/create_app.mjs <app-dir>
import { appendFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './pack_checkout.mjs'
import { createAdonisApp } from './scaffold_app.mjs'

const overlay = fileURLToPath(new URL('overlay', import.meta.url))
const { appDir, tarball } = createAdonisApp('create_app.mjs')

run('npm', ['install', join('..', tarball), '@adonisjs/limiter', 'typescript@^5.9.3'], appDir)
run('node', ['ace', 'configure', '@adonisjs/limiter', '--store=database'], appDir)
run('node', ['ace', 'configure', 'adonisjs-account-kit'], appDir)

// Every capability except social sign-in, managed routes under /api, emails printed to the log.
cpSync(overlay, appDir, { recursive: true })
appendFileSync(join(appDir, 'start/routes.ts'), "import './account_kit_routes.js'\n")
console.log(`Demo app ready in ${appDir}`)
