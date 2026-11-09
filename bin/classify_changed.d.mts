// Types for bin/classify_changed.mjs, which stays plain JavaScript so the workflow's plan job can
// run it before `pnpm install`.
import type { Classification } from './check_changed_plan.js'

export const starterWorkflow: string
export const rootReadme: string
export function classify(
  files: { path: string; status: string }[],
  readDiff: (path: string) => string
): { classification: Classification; reason: string }
export function classifyRepository(
  base: string | undefined,
  cwd?: string
): { classification: Classification; reason: string }
