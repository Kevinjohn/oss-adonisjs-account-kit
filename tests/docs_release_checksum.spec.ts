import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { repoRoot } from './helpers/tracked_markdown.js'

// SECURITY.md tells users to check the archive against the SHA-256 in the release notes, so the
// documented release command must put it there.
test('the documented manual release puts the archive SHA-256 in the release notes', async ({
  assert,
}) => {
  const source = await readFile(join(repoRoot, 'docs/maintainers/release-gate.md'), 'utf8')
  const commands = [...source.matchAll(/gh release create(?:\\\n|[^\n])*/g)].map(
    ([command]) => command
  )
  assert.isAbove(commands.length, 0)
  for (const command of commands) assert.match(command, /--notes "[^"]*shasum -a 256/)
})
