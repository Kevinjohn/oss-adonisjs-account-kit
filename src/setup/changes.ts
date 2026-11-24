import type { SetupFileChange, SetupInspection } from './types.js'

export { generateEnvironmentTemplate } from './generated_sources.js'
export { migrationContent, requireMigrationTemplatePath } from './migration_source.js'

export function addChange(
  changes: SetupFileChange[],
  state: SetupInspection,
  path: string,
  content: string,
  reason: string
) {
  const existing = state.files[path]
  changes.push({
    path,
    action: existing === undefined ? 'create' : existing === content ? 'unchanged' : 'conflict',
    content,
    reason,
  })
}

export function recordOwnedChange(
  changes: SetupFileChange[],
  state: SetupInspection,
  path: string,
  content: string,
  oldGenerated: string | null,
  reason: string
) {
  const existing = state.files[path]
  changes.push({
    path,
    action:
      existing === undefined
        ? 'create'
        : existing === content
          ? 'unchanged'
          : oldGenerated !== null && existing === oldGenerated
            ? 'update'
            : 'conflict',
    expected: existing,
    content,
    reason,
  })
}
