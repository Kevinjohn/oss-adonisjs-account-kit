// Classifies changes before dependencies are installed. Node 24 strips the types natively.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import type { Classification } from './check_changed_plan.ts'

interface ClassifiedChange {
  classification: Classification
  reason: string
}

export const rootReadme = 'README.md'

/**
 * Classify changed files. `files` holds one entry per path with its git status letter (`M`, `A`,
 * `D`, `R`, ... or `?` for an untracked file).
 */
export function classify(files: { path: string; status: string }[]): ClassifiedChange {
  if (files.length === 0) return { classification: 'full', reason: 'no changed files' }
  if (files.length > 1) {
    const other = files.find((file) => file.path !== rootReadme) ?? files[1]
    return { classification: 'full', reason: `${other.path} changed too` }
  }
  const [file] = files
  if (file.status !== 'M')
    return { classification: 'full', reason: `${file.path} is ${file.status}` }
  if (file.path === rootReadme)
    return { classification: 'root-readme-only', reason: 'only README.md changed' }
  return { classification: 'full', reason: `${file.path} changed` }
}

/**
 * Classify the working tree's commits since the merge base with `base`. Untracked files count.
 */
export function classifyRepository(
  base: string | undefined,
  cwd = process.cwd()
): ClassifiedChange {
  const git = (...args: string[]) => {
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
  return classify(files)
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
