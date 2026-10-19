import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Tracked Markdown files matching the globs; ignored local notes are not published. */
export function trackedMarkdown(globs: string[]): string[] {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--', ...globs.map((glob) => `:(glob)${glob}`)],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (listed.status !== 0) throw new Error(listed.stderr)
  return listed.stdout.split('\0').filter(Boolean)
}
