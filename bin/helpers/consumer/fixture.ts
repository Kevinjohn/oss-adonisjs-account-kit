import { cp } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Copy source without a developer's database, secrets or installed/build artifacts. */
export async function copyFixture(source: string, destination: string) {
  const localDirectories = new Set(['node_modules', 'tmp', 'build', 'vendor', '.adonisjs'])
  // Recipe acceptance specs import the example's own config seam, which the generated consumer
  // config does not have; `pnpm test:recipe` runs them against the pinned starter.
  const recipes = join('tests', 'recipes')
  await cp(source, destination, {
    recursive: true,
    filter: (path) => {
      const relativePath = relative(source, path)
      if (relativePath === recipes || relativePath.startsWith(recipes + sep)) return false
      const name = relativePath.split(sep)[0]
      return (
        !localDirectories.has(name) && (name === '.env.example' || !/^\.env(?:$|\.)/.test(name))
      )
    },
  })
}
