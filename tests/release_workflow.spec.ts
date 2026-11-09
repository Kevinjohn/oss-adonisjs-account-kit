import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { repoRoot } from './helpers/tracked_markdown.js'

/** Each job's block under `jobs:`, keyed by name, with its `needs` list. */
function jobs(workflow: string): Map<string, { block: string; needs: string[] }> {
  const result = new Map<string, { block: string; needs: string[] }>()
  const body = workflow.slice(workflow.indexOf('\njobs:\n'))
  for (const [, name, block] of body.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\s*\n)*)/gm)) {
    const needs = block.match(/^ {4}needs: (.+)$/m)?.[1] ?? ''
    result.set(name, {
      block,
      needs: needs
        .replace(/[[\]]/g, '')
        .split(',')
        .map((need) => need.trim())
        .filter(Boolean),
    })
  }
  return result
}

// A release started from another branch must stop before the checks spend their minutes.
test('every release job waits for the main-only guard', async ({ assert }) => {
  const workflow = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  const all = jobs(workflow)
  assert.match(
    workflow,
    /main-only:\n(?: {4}.*\n)*? {6}- run: test "\$GITHUB_REF" = "refs\/heads\/main"/
  )
  const guarded = (job: string): boolean =>
    (all.get(job)?.needs ?? []).some((need) => need === 'main-only' || guarded(need))
  const unguarded = [...all.keys()].filter((job) => job !== 'main-only' && !guarded(job))
  assert.isAbove(all.size, 1)
  assert.deepEqual(unguarded, [])
})

// Install and build scripts run dependency code; none of it may hold a token that can create
// releases or push tags.
test('only the job that creates the release can write, and it runs no repository code', async ({
  assert,
}) => {
  const workflow = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  assert.match(workflow, /^permissions:\n {2}contents: read$/m)
  const writers = [...jobs(workflow)].filter(([, job]) =>
    /^ {4}permissions: write-all$|^ {4}permissions:\n(?: {6}.*\n)*? {6}contents: write$/m.test(
      job.block
    )
  )
  assert.lengthOf(writers, 1)
  const [, release] = writers[0]
  const steps = [...release.block.matchAll(/^ {6}- (?:uses|run): (.+)$/gm)].map(([, step]) => step)
  assert.lengthOf(steps, 1)
  assert.match(steps[0], /^actions\/download-artifact@/)
  const runs = [...release.block.matchAll(/^ {8}run: (.+)$/gm)].map(([, run]) => run)
  assert.lengthOf(runs, 1)
  assert.match(runs[0], /^gh release create /)
  assert.notInclude(release.block, 'actions/checkout')
  assert.notInclude(release.block, 'pnpm')
})

// The release job reads the gate's outputs; a renamed step id or key would empty them.
test('the release job receives the version and tarball the gate wrote', async ({ assert }) => {
  const workflow = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  const all = jobs(workflow)
  const packageJob = all.get('package')?.block ?? ''
  const release = all.get('release')?.block ?? ''
  assert.match(packageJob, /^ {8}id: check$/m)
  for (const key of ['version', 'tarball']) {
    assert.include(packageJob, `${key}: \${{ steps.check.outputs.${key} }}`)
    assert.include(release, `\${{ needs.package.outputs.${key} }}`)
  }
  assert.include(release, 'needs: package')
})

// Four kits cost about ten runner-minutes; they run against the release commit and the starter
// ref pinned in it, not on every pull request or push.
test('the starter integrations run only from the release workflow or by hand', async ({
  assert,
}) => {
  const starter = await readFile(join(repoRoot, '.github/workflows/starter-examples.yml'), 'utf8')
  const triggers = starter.slice(starter.indexOf('\non:\n'), starter.indexOf('\npermissions:\n'))
  assert.match(triggers, /^ {2}workflow_call:$/m)
  assert.match(triggers, /^ {2}workflow_dispatch:$/m)
  assert.notMatch(triggers, /^ {2}(?:pull_request|push)\b/m)
  assert.match(starter, /^env:\n {2}STARTER_EXAMPLES_REF: \S+$/m)
  assert.include(starter, 'ref: ${{ env.STARTER_EXAMPLES_REF }}')
  assert.match(starter, /^ {8}kit: \[api, hypermedia, inertia-react, inertia-vue\]$/m)

  const release = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  const starterJob = jobs(release).get('starter-examples')
  assert.include(starterJob?.block, 'uses: ./.github/workflows/starter-examples.yml')
})

// A failing kit, or any other called workflow, must stop packaging and the release.
test('packaging waits for every workflow the release calls', async ({ assert }) => {
  const release = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  const all = jobs(release)
  const called = [...all].filter(([, job]) => /^ {4}uses: /m.test(job.block)).map(([name]) => name)
  assert.include(called, 'starter-examples')
  assert.sameMembers(all.get('package')?.needs ?? [], called)
})
