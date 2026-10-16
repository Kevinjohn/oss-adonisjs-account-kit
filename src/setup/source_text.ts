/** Remove JavaScript/TypeScript comments without changing quoted source text or offsets. */
export function stripSourceComments(source: string): string {
  let result = ''
  let mode: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code'
  const interpolations: number[] = []

  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]

    if (mode === 'line') {
      if (char === '\n' || char === '\r') {
        result += char
        mode = 'code'
      } else result += ' '
      continue
    }
    if (mode === 'block') {
      if (char === '*' && next === '/') {
        result += '  '
        index++
        mode = 'code'
      } else result += char === '\n' || char === '\r' ? char : ' '
      continue
    }

    if (mode === 'single' || mode === 'double' || mode === 'template') {
      result += char
      if (char === '\\' && next !== undefined) {
        result += next
        index++
      } else if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"')) {
        mode = 'code'
      } else if (mode === 'template') {
        if (char === '`') mode = 'code'
        else if (char === '$' && next === '{') {
          result += next
          index++
          interpolations.push(1)
          mode = 'code'
        }
      }
      continue
    }

    if (char === '/' && (next === '/' || next === '*')) {
      result += '  '
      index++
      mode = next === '/' ? 'line' : 'block'
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      result += char
      mode = char === "'" ? 'single' : char === '"' ? 'double' : 'template'
      continue
    }
    if (interpolations.length) {
      const top = interpolations.length - 1
      if (char === '{') interpolations[top]++
      else if (char === '}' && --interpolations[top] === 0) {
        interpolations.pop()
        mode = 'template'
      }
    }
    result += char
  }

  return result
}

/** Keep source offsets and literal delimiters, but hide text that cannot be executable syntax. */
export function maskSourceLiteralBodies(source: string): string {
  const uncommented = stripSourceComments(source)
  const chars = uncommented.split('')
  const frames: Array<{
    kind: 'code' | 'single' | 'double' | 'template' | 'expression'
    braces?: number
  }> = [{ kind: 'code' }]
  let templateDepth = 0
  const blank = (index: number) => {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
  }

  for (let index = 0; index < source.length; index++) {
    const char = uncommented[index]
    const next = uncommented[index + 1]
    const frame = frames.at(-1)!

    if (frame.kind === 'single' || frame.kind === 'double') {
      if (char === '\\' && next !== undefined) {
        blank(index)
        blank(++index)
      } else if (char === (frame.kind === 'single' ? "'" : '"')) {
        if (templateDepth) blank(index)
        frames.pop()
      } else blank(index)
      continue
    }
    if (frame.kind === 'template') {
      if (char === '\\' && next !== undefined) {
        blank(index)
        blank(++index)
      } else if (char === '`') {
        templateDepth--
        if (templateDepth) blank(index)
        frames.pop()
      } else if (char === '$' && next === '{') {
        blank(index)
        blank(++index)
        frames.push({ kind: 'expression', braces: 1 })
      } else blank(index)
      continue
    }

    if (char === "'" || char === '"') {
      if (templateDepth) blank(index)
      frames.push({ kind: char === "'" ? 'single' : 'double' })
    } else if (char === '`') {
      if (templateDepth) blank(index)
      templateDepth++
      frames.push({ kind: 'template' })
    } else if (frame.kind === 'expression') {
      if (char === '{') frame.braces!++
      else if (char === '}' && --frame.braces! === 0) frames.pop()
      blank(index)
    }
  }
  return chars.join('')
}
