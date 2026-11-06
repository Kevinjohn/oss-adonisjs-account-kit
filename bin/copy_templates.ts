import { copyFileSync, globSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

for (const source of globSync('stubs/**/*.stub')) {
  const destination = join('build', relative('stubs', source))
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}
