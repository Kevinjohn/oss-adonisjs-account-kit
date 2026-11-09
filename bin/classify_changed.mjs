// Classifies a branch's changes for the checks workflow. Two narrow shapes get a focused run;
// everything else is `full`. Plain JavaScript with no imports from node_modules: the workflow's
// plan job runs it before `pnpm install`, which would compile the package through `prepare`.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const starterWorkflow = '.github/workflows/starter-examples.yml'
export const rootReadme = 'README.md'
const pinLine = /^[-+]\s*STARTER_EXAMPLES_REF: \S+$/

/**
 * Classify changed files. `files` holds one entry per path with its git status letter (`M`, `A`,
 * `D`, `R`, ... or `?` for an untracked file); `readDiff` returns the `-U0` diff of one path.
 * @param {{ path: string, status: string }[]} files
 * @param {(path: string) => string} readDiff
 * @returns {{ classification: 'starter-pin-only' | 'root-readme-only' | 'full', reason: string }}
 */
export function classify(files, readDiff) {
  if (files.length === 0) return { classification: 'full', reason: 'no changed files' }
  if (files.length > 1) {
    const other =
      files.find((file) => ![starterWorkflow, rootReadme].includes(file.path)) ?? files[1]
    return { classification: 'full', reason: `${other.path} changed too` }
  }
  const [file] = files
  if (file.status !== 'M')
    return { classification: 'full', reason: `${file.path} is ${file.status}` }
  if (file.path === rootReadme)
    return { classification: 'root-readme-only', reason: 'only README.md changed' }
  if (file.path !== starterWorkflow)
    return { classification: 'full', reason: `${file.path} changed` }
  const changedLines = readDiff(file.path)
    .split('\n')
    .filter((line) => /^[-+]/.test(line) && !/^(?:---|\+\+\+) /.test(line))
  if (changedLines.length === 0) return { classification: 'full', reason: 'unparsable diff' }
  const offending = changedLines.find((line) => !pinLine.test(line))
  if (offending)
    return {
      classification: 'full',
      reason: `${file.path} changes more than the pin: ${offending}`,
    }
  return { classification: 'starter-pin-only', reason: 'only the STARTER_EXAMPLES_REF pin changed' }
}

/**
 * Classify the working tree's commits since the merge base with `base`. Untracked files count.
 * @param {string} base
 * @param {string} cwd
 */
export function classifyRepository(base, cwd = process.cwd()) {
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    return result.status === 0 ? result.stdout : undefined
  }
  if (!base) return { classification: 'full', reason: 'no base ref' }
  const mergeBase = git('merge-base', base, 'HEAD')?.trim()
  if (!mergeBase) return { classification: 'full', reason: `no merge base with ${base}` }
  const files = []
  const changed = git('diff', '--name-status', '--no-renames', '-z', mergeBase)?.split('\0') ?? []
  for (let index = 0; index + 1 < changed.length; index += 2)
    files.push({ path: changed[index + 1], status: changed[index] })
  for (const path of git('ls-files', '-z', '--others', '--exclude-standard')?.split('\0') ?? [])
    if (path) files.push({ path, status: '?' })
  return classify(files, (path) => git('diff', '-U0', '--no-renames', mergeBase, '--', path) ?? '')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { classification, reason } = classifyRepository(process.argv[2])
  console.log(`classification=${classification}`)
  console.log(`reason=${reason}`)
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `classification=${classification}\nfocused=${classification === 'full' ? 'false' : 'true'}\n`
    )
  }
}
