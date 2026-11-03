import { readFile } from 'node:fs/promises'
import { join, matchesGlob } from 'node:path'
import { test } from '@japa/runner'
import { repoRoot } from './helpers/tracked_markdown.js'

// A pull request that changes something the examples job reads must run that job, or the break
// first shows up on the weekly schedule or at release.
test('the examples workflow runs for pull requests that change its own inputs', async ({
  assert,
}) => {
  const workflow = await readFile(join(repoRoot, '.github/workflows/examples.yml'), 'utf8')
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const paths = [
    ...workflow.match(/pull_request:\n {4}paths:\n((?: {6}- .*\n)+)/)![1].matchAll(/'([^']+)'/g),
  ].map(([, path]) => path)
  const inputs = [...workflow.matchAll(/\bbin\/[\w/]+\.ts\b/g)].map(([path]) => path)
  for (const [, script, recipe] of workflow.matchAll(/pnpm (test:recipe) --recipe=([\w-]+)/g)) {
    inputs.push(manifest.scripts[script].match(/bin\/[\w/]+\.ts/)[0])
    inputs.push(`docs/recipes/patches/${recipe}.patch`)
  }
  assert.isAbove(inputs.length, 2)
  assert.deepEqual(
    inputs.filter((input) => !paths.some((path) => matchesGlob(input, path))),
    []
  )
})
