import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { repoRoot, trackedMarkdown } from './helpers/tracked_markdown.js'

/** TypeScript controller snippets in tracked Markdown, which readers copy into their apps. */
async function controllerSnippets(): Promise<{ document: string; code: string }[]> {
  const snippets: { document: string; code: string }[] = []
  for (const document of trackedMarkdown(['**/*.md'])) {
    const source = await readFile(join(repoRoot, document), 'utf8')
    for (const [, code] of source.matchAll(/```ts\n([\s\S]*?)```/g))
      if (code.includes('HttpContext')) snippets.push({ document, code })
  }
  return snippets
}

// The shared idiom: return the normal response and log, because the change already committed.
const committed =
  /if \(!\(error instanceof DeliveryError \|\| error instanceof PostCommitError\)\)\s+(?:throw error|return knownError\()/g

test('password reset snippets give the normal response when a notification fails', async ({
  assert,
}) => {
  const all = await controllerSnippets()
  const snippets = all.filter(({ code }) => /passwordReset\.(request|reset)\(/.test(code))
  assert.isAbove(snippets.length, 0)
  // A request emails known addresses only, so an escaping DeliveryError reveals the account. A
  // reset has already changed the password, so an error would tell the user it failed.
  const leaking = snippets
    .filter(({ code }) => {
      const calls = code.match(/passwordReset\.(request|reset)\(/g) ?? []
      return (code.match(committed) ?? []).length < calls.length
    })
    .map(({ document }) => document)
  assert.deepEqual(leaking, [])
})

test('proof page snippets keep the token out of the Referer', async ({ assert }) => {
  const all = await controllerSnippets()
  const pages = all.filter(
    ({ code }) => code.includes('.render(') && /\.inspect\(\{ token/.test(code)
  )
  assert.isAbove(pages.length, 0)
  const leaking = pages
    .filter(({ code }) => !code.includes('Referrer-Policy'))
    .map(({ document }) => document)
  assert.deepEqual(leaking, [])
})

test('the development mail recipe shows the log capture other pages link it for', async ({
  assert,
}) => {
  const source = await readFile(join(repoRoot, 'docs/recipes/development-mail.md'), 'utf8')
  const snippets = [...source.matchAll(/```ts\n([\s\S]*?)```/g)].map(([, code]) => code)
  assert.isTrue(snippets.some((code) => code.includes('createLogNotifications(')))
})
