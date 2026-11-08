/** A fenced code block that a `<!-- source: path#region -->` marker ties to a source region. */
export interface SourceExample {
  line: number
  target: string
  body: string
}

/**
 * The sourced examples in one Markdown document, and marker errors. A marker must be followed,
 * after blank lines only, by a closed code fence. Ported from the source example part of Lucid
 * Soft Delete's `bin/docs_check.ts`.
 */
export function sourceExamples(contents: string): { examples: SourceExample[]; errors: string[] } {
  const examples: SourceExample[] = []
  const errors: string[] = []
  let source: { target: string; line: number } | undefined
  let fence: { character: string; length: number; body: string[] } | undefined
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`).test(line)) {
        if (source) examples.push({ ...source, body: fence.body.join('\n') })
        source = undefined
        fence = undefined
      } else fence.body.push(line)
      continue
    }
    const marker = line.match(/^\s*<!-- source: (\S+) -->\s*$/)
    if (marker) {
      if (source) errors.push(`line ${source.line}: source marker requires a following code fence`)
      source = { target: marker[1], line: index + 1 }
      continue
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length, body: [] }
      continue
    }
    if (source && line.trim()) {
      errors.push(`line ${source.line}: source marker requires a following code fence`)
      source = undefined
    }
  }
  if (source) errors.push(`line ${source.line}: source marker requires a closed code fence`)
  return { examples, errors }
}

/** The code between `// #region <name>` and `// #endregion <name>`, or undefined when missing. */
export function sourceRegion(source: string, name: string): string | undefined {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `// #region ${name}`)
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === `// #endregion ${name}`
  )
  if (!name || start < 0 || end < 0) return undefined
  return lines.slice(start + 1, end).join('\n')
}
