import { cp } from 'node:fs/promises'
import { relative, sep } from 'node:path'

/** Copy source without a developer's database, secrets or installed/build artifacts. */
export async function copyFixture(source, destination) {
  const localDirectories = new Set(['node_modules', 'tmp', 'build', 'vendor', '.adonisjs'])
  await cp(source, destination, {
    recursive: true,
    filter: (path) => {
      const name = relative(source, path).split(sep)[0]
      return (
        !localDirectories.has(name) && (name === '.env.example' || !/^\.env(?:$|\.)/.test(name))
      )
    },
  })
}
