import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { repoRoot } from './helpers/tracked_markdown.js'

/** Each job's `needs`, read from the two-space job headers under `jobs:`. */
function jobNeeds(workflow: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>()
  const body = workflow.slice(workflow.indexOf('\njobs:\n'))
  for (const [, name, block] of body.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\s*\n)*)/gm)) {
    const needs = block.match(/^ {4}needs: (.+)$/m)?.[1] ?? ''
    jobs.set(
      name,
      needs
        .replace(/[[\]]/g, '')
        .split(',')
        .map((need) => need.trim())
        .filter(Boolean)
    )
  }
  return jobs
}

// A release started from another branch must stop before the checks spend their minutes.
test('every release job waits for the main-only guard', async ({ assert }) => {
  const workflow = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  const jobs = jobNeeds(workflow)
  assert.match(
    workflow,
    /main-only:\n(?: {4}.*\n)*? {6}- run: test "\$GITHUB_REF" = "refs\/heads\/main"/
  )
  const guarded = (job: string): boolean =>
    (jobs.get(job) ?? []).some((need) => need === 'main-only' || guarded(need))
  const unguarded = [...jobs.keys()].filter((job) => job !== 'main-only' && !guarded(job))
  assert.isAbove(jobs.size, 1)
  assert.deepEqual(unguarded, [])
})
