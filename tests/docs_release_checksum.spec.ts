import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { repoRoot } from './helpers/tracked_markdown.js'

// SECURITY.md tells users to check the archive against the SHA-256 in the release notes, so the
// documented workflow must publish the notes produced by the checked release gate.
test('the documented release workflow publishes the generated checksum notes', async ({
  assert,
}) => {
  const [guide, workflow] = await Promise.all([
    readFile(join(repoRoot, 'docs/maintainers/release-gate.md'), 'utf8'),
    readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8'),
  ])
  assert.include(guide, 'bin/release_check.sh')
  assert.match(workflow, /^\s+run: bash bin\/release_check\.sh\s*$/m)
  const commands = [...workflow.matchAll(/^\s+run: (gh release create[^\n]*)/gm)].map(
    ([, command]) => command
  )
  assert.isAbove(commands.length, 0)
  for (const command of commands) assert.match(command, /--notes-file tmp\/release\/notes\.md\b/)
})
