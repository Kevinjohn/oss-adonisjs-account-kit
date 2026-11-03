import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { repoRoot } from './helpers/tracked_markdown.js'

test('the dev container activates the pinned pnpm through Corepack', async ({ assert }) => {
  const read = async (path: string) => JSON.parse(await readFile(join(repoRoot, path), 'utf8'))
  const { postCreateCommand } = await read('.devcontainer/devcontainer.json')
  const { packageManager } = await read('package.json')
  assert.include(postCreateCommand, `corepack prepare ${packageManager} --activate`)
  // The image runs as `node`, which cannot write the Corepack shims beside the root-owned node
  // binary in /usr/local/bin.
  assert.match(postCreateCommand, /^sudo corepack enable pnpm && /)
})
