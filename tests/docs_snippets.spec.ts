import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** TypeScript controller snippets in tracked Markdown, which readers copy into their apps. */
async function controllerSnippets(): Promise<{ document: string; code: string }[]> {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ':(glob)**/*.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (listed.status !== 0) throw new Error(listed.stderr)
  const snippets: { document: string; code: string }[] = []
  for (const document of listed.stdout.split('\0').filter(Boolean)) {
    const source = await readFile(join(repoRoot, document), 'utf8')
    for (const [, code] of source.matchAll(/```ts\n([\s\S]*?)```/g))
      if (code.includes('HttpContext')) snippets.push({ document, code })
  }
  return snippets
}

test('reset request snippets give the generic response when delivery fails', async ({ assert }) => {
  const all = await controllerSnippets()
  const snippets = all.filter(({ code }) => code.includes('passwordReset.request('))
  assert.isAbove(snippets.length, 0)
  // Only known addresses get an email, so an unhandled DeliveryError reveals the account.
  const leaking = snippets
    .filter(({ code }) => !code.includes('DeliveryError') || !code.includes('PostCommitError'))
    .map(({ document }) => document)
  assert.deepEqual(leaking, [])
})

test('proof page snippets keep the token out of the Referer', async ({ assert }) => {
  const all = await controllerSnippets()
  const snippets = all.filter(({ code }) => code.includes('.render('))
  const leaking = snippets
    .filter(({ code }) => /\.inspect\(\{ token/.test(code) && !code.includes('Referrer-Policy'))
    .map(({ document }) => document)
  assert.deepEqual(leaking, [])
})
