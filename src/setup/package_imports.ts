/** Confirm the runtime package alias resolves to the exact contained source we inspect. */
export function conventionalSetupImport(
  manifestText: string | undefined,
  specifier: string,
  wildcard: string,
  wildcardTarget: string,
  exactTarget: string
): boolean {
  const manifest = JSON.parse(manifestText ?? '{}') as {
    imports?: Record<string, unknown>
  }
  const imports = manifest.imports ?? {}
  const overlaps = Object.keys(imports).some((key) => {
    if (key === specifier || key === wildcard) return false
    const star = key.indexOf('*')
    return (
      star >= 0 &&
      specifier.startsWith(key.slice(0, star)) &&
      specifier.endsWith(key.slice(star + 1))
    )
  })
  if (overlaps) return false
  return imports[specifier] === undefined
    ? imports[wildcard] === wildcardTarget
    : imports[specifier] === exactTarget
}
