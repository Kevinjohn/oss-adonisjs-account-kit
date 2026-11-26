import { spawnSync } from 'node:child_process'
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

test('packaging waits for successful CI and publication waits for packaging', async ({
  assert,
}) => {
  const workflow = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  const all = jobs(workflow)
  assert.sameMembers([...all.keys()], ['ci', 'package', 'release'])
  assert.deepEqual(all.get('ci')?.needs, [])
  assert.deepEqual(all.get('package')?.needs, ['ci'])
  assert.deepEqual(all.get('release')?.needs, ['package'])
  for (const [, job] of all) assert.notMatch(job.block, /^ {4}if:/m)
  assert.match(
    all.get('ci')?.block ?? '',
    /^ {4}permissions:\n {6}actions: read\n {6}contents: read$/m
  )
})

test('the CI gate accepts only a successful push run with both database jobs on the release SHA', async ({
  assert,
}) => {
  const workflow = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  const ci = jobs(workflow).get('ci')?.block ?? ''
  const script = ci.split(/^ {8}run: \|\n/m)[1]?.replace(/^ {10}/gm, '')
  assert.isNotEmpty(script)

  const sha = 'a'.repeat(40)
  const runs = JSON.stringify([{ databaseId: 42, headSha: sha }])
  const passingJobs = ['checks (better-sqlite3)', 'checks (pg)'].map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
  }))
  const skippedJobs = JSON.stringify({
    jobs: [
      passingJobs[0],
      { ...passingJobs[1], conclusion: 'skipped' },
      { name: 'checks-gate', status: 'completed', conclusion: 'success' },
    ],
  })
  const gh = `gh() {
    case "$*" in
      "run list --repo demo/account-kit --workflow checks.yml --branch main --event push --commit ${sha} --limit 1 --json databaseId,headSha")
        printf '%s\\n' "$RUNS" ;;
      "run watch 42 --repo demo/account-kit --interval 30 --exit-status")
        echo watch
        return "$WATCH_STATUS" ;;
      "api repos/demo/account-kit/actions/runs/42/jobs?filter=latest&per_page=100")
        printf '%s\\n' "$JOBS"
        return "$API_STATUS" ;;
      *) echo "Unexpected gh call: $*" >&2; return 99 ;;
    esac
  }`
  for (const [name, overrides, status, output] of [
    ['matching run', {}, 0, 'watch\ntrue'],
    ['wrong SHA', { RUNS: runs.replace(sha, 'b'.repeat(40)) }, 1, 'No checks.yml push run'],
    ['missing run', { RUNS: '[]' }, 1, 'No checks.yml push run'],
    ['invalid run ID', { RUNS: runs.replace('42', '"42"') }, 1, 'No checks.yml push run'],
    ['other branch', { GITHUB_REF: 'refs/heads/topic' }, 1, 'release runs on main only'],
    ['failed watch', { WATCH_STATUS: '23' }, 23, 'watch'],
    ['skipped job', { JOBS: skippedJobs }, 1, 'watch\nfalse'],
    ['API error', { API_STATUS: '24' }, 24, 'watch\ntrue'],
  ] as const) {
    const result = spawnSync('bash', ['-c', `${gh}\n${script}`], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GITHUB_REPOSITORY: 'demo/account-kit',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: sha,
        RUNS: runs,
        JOBS: JSON.stringify({ jobs: passingJobs }),
        WATCH_STATUS: '0',
        API_STATUS: '0',
        ...overrides,
      },
    })
    assert.equal(result.status, status, `${name}: ${result.stderr}`)
    assert.include(result.stdout, output, name)
  }
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
  assert.equal(runs[0], '|')
  assert.match(release.block, /^ {10}gh release create /m)
  assert.notInclude(release.block, 'actions/checkout')
  assert.notInclude(release.block, 'pnpm')
})

// The release job reads the gate's outputs; a renamed step id or key would empty them.
test('the release job receives the version, tarball and digest the gate wrote', async ({
  assert,
}) => {
  const workflow = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  const all = jobs(workflow)
  const packageJob = all.get('package')?.block ?? ''
  const release = all.get('release')?.block ?? ''
  assert.match(packageJob, /^ {8}id: check$/m)
  for (const key of ['version', 'tarball', 'sha256']) {
    assert.include(packageJob, `${key}: \${{ steps.check.outputs.${key} }}`)
    assert.include(release, `\${{ needs.package.outputs.${key} }}`)
  }
  assert.include(release, 'needs: package')
})

test('packaging tests the release archive and checks the consumer digest before upload', async ({
  assert,
}) => {
  const workflow = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  const block = jobs(workflow).get('package')?.block ?? ''
  const pack = block.indexOf('pnpm release')
  const consumer = block.indexOf('pnpm test:consumer')
  const digest = block.indexOf('.status == "passed" and .candidateSha256 == $sha256')
  const upload = block.indexOf('actions/upload-artifact@')
  assert.isAtLeast(pack, 0)
  assert.isAbove(consumer, pack)
  assert.isAbove(digest, consumer)
  assert.isAbove(upload, digest)
  assert.include(block, '--candidate-tarball="tmp/release/$TARBALL"')
  assert.include(block, 'TARBALL: ${{ steps.check.outputs.tarball }}')
  assert.include(block, 'SHA256: ${{ steps.check.outputs.sha256 }}')
})
