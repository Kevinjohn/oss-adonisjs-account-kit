// Builds a fresh AdonisJS API app with the packed Account Kit, ready for record.ts.
// Usage: node bin/demos/create_app.ts <app-dir>
import { appendFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './pack_checkout.ts'
import { createAdonisJsApp } from './scaffold_app.ts'
import { writeDemoIdentity } from './demo_identity.ts'

function copyOverlay(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name.replace(/\.stub$/, ''))
    if (entry.isDirectory()) copyOverlay(source, target)
    else copyFileSync(source, target)
  }
}

const overlay = fileURLToPath(new URL('overlay', import.meta.url))
const { appDir, archivePath } = createAdonisJsApp('create_app.ts')

run('pnpm', ['add', archivePath, '@adonisjs/limiter', 'typescript@^5.9.3'], appDir)
run('node', ['ace', 'configure', '@adonisjs/limiter', '--store=database'], appDir)
run('node', ['ace', 'configure', '@kevinjohn/adonisjs-account-kit'], appDir)

// Every capability except social sign-in, managed routes under /api, emails printed to the log.
copyOverlay(overlay, appDir)
appendFileSync(join(appDir, 'start/routes.ts'), "import './account_kit_routes.js'\n")
writeDemoIdentity(appDir, 'feature-recording')
console.log(`Demo app ready in ${appDir}`)
